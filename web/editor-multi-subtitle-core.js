// 多重字幕核心：副轨状态、绑定关系、范围钳制与双轨联动计算。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweMultiSubtitleCore 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweMultiSubtitleCore(global) {
  'use strict';


  const MULTI_SUBTITLE_TOLERANCE_MS = window.AsrEditorUtils.MULTI_SUBTITLE_TOLERANCE_MS || 300;


  const MULTI_SUBTITLE_MERGE_OVERLAP_TOLERANCE_MS = 500;


  const SUBTITLE_MIN_DURATION_MS = 100;


  const PROJECT_SEGMENT_OVERLAP_AUTO_FIX_MAX_MS = 2;


  const MULTI_SUBTITLE_IMPORT_PROMPT = '是否导入第二条字幕？（后续也可以将字幕或工程拖入编辑器加载）';


  const MULTI_SUBTITLE_TOGGLE_TITLE = '当前工程如果有大于1条字幕，可以开启多重字幕模式，用于双语字幕编辑等。';


  let normalizedMultiSubtitleReference = null;


  let pendingSrtImportAsExtension = false;



  function normalizeMultiSubtitleState() {
    if (normalizedMultiSubtitleReference === MaweBoot.DATA.multi_subtitle) return MaweBoot.DATA.multi_subtitle;
    window.AsrEditorUtils.normalizeMultiSubtitleProject(MaweBoot.DATA);
    normalizedMultiSubtitleReference = MaweBoot.DATA.multi_subtitle;
    return MaweBoot.DATA.multi_subtitle;
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
    return window.AsrEditorUtils.MULTI_SUBTITLE_SPLIT_MODES.has(value);
  }



  function getMainSubtitleSplitMode(segment = null) {
    // 类型来源三级：用户手动指定（本地偏好，两个入口共享、多重字幕开关无关）
    // → 工程显式配置的 main_split_mode（仅多重字幕开启时沿用旧契约语义）
    // → 按主字幕文本实时检测。
    const override = MaweSettings.EDITOR_SETTINGS.mainSplitModeOverride;
    if (override === 'word' || override === 'continuous') return override;
    const multi = getMultiSubtitleState();
    if (multi.enabled === true && isConfiguredSubtitleSplitMode(multi.main_split_mode)) {
      return multi.main_split_mode;
    }
    const text = segment?.text ?? MaweBoot.DATA.segments.map((item) => item?.text || '').join('\n');
    return window.AsrEditorUtils.detectSubtitleSplitMode(text);
  }



  function getExtensionSubtitleSplitMode(track = getActiveExtensionTrack(), segment = null) {
    if (isConfiguredSubtitleSplitMode(track?.split_mode)) return track.split_mode;
    const text = segment?.text ?? (track?.segments || []).map((item) => item?.text || '').join('\n');
    return window.AsrEditorUtils.detectSubtitleSplitMode(text, track?.language);
  }



  function splitModeLabel(mode) {
    return mode === 'continuous' ? '字符型' : '单词型';
  }


  function splitModeExample(mode) {
    return mode === 'continuous' ? '（适用于中文、日文等语言）' : '（适用于英文、俄文等语言）';
  }



  // 合并多条字幕时按「字符型/单词型」取对应连接符：中文直接拼接，西文默认空格。
  function mergeJoinSeparatorForMode(splitMode) {
    return splitMode === 'continuous'
      ? MaweSettings.EDITOR_SETTINGS.mergeJoinTextContinuous
      : MaweSettings.EDITOR_SETTINGS.mergeJoinTextWord;
  }



  function multiSubtitleWaveformStructureKey(state = getMultiSubtitleState()) {
    const trackIds = Array.isArray(state?.tracks)
      ? state.tracks.map((track) => String(track?.id || '')).join('|')
      : '';
    return `${state?.enabled === true ? '1' : '0'}:${trackIds}`;
  }



  function mainSegmentById(id) {
    const target = String(id || '');
    return MaweBoot.DATA.segments.find((segment) => segment?.id === target) || null;
  }



  function extensionSegmentById(id, track = getActiveExtensionTrack()) {
    const target = String(id || '');
    return track?.segments?.find((segment) => segment?.id === target) || null;
  }



  function bindingForMainIndex(index) {
    const segment = MaweBoot.DATA.segments[index];
    return segment ? window.AsrEditorUtils.bindingForSegment(getMultiSubtitleState(), segment.id, 'main') : null;
  }



  function bindingForExtensionIndex(index, track = getActiveExtensionTrack()) {
    const segment = track?.segments?.[index];
    return segment ? window.AsrEditorUtils.bindingForSegment(getMultiSubtitleState(), segment.id, 'extension', track.id) : null;
  }



  function getBindingMarkerTargets() {
    const main = new Set();
    const extension = new Set();
    if (!multiSubtitleVisible()) return { main, extension };
    const track = getActiveExtensionTrack();
    const addBindingTargets = (binding) => {
      if (!binding) return;
      (binding.main_segment_ids || []).forEach((id) => {
        const index = MaweBoot.DATA.segments.findIndex((segment) => segment?.id === id);
        if (index >= 0) main.add(index);
      });
      const bindingTrack = getExtensionTrack(binding.track_id) || track;
      (binding.extension_segment_ids || []).forEach((id) => {
        const index = bindingTrack?.segments?.findIndex((segment) => segment?.id === id) ?? -1;
        if (index >= 0 && bindingTrack === track) extension.add(index);
      });
    };
    MaweSelection.selectedIdxs.forEach((index) => addBindingTargets(bindingForMainIndex(index)));
    MaweSelection.selectedExtensionIdxs.forEach((index) => addBindingTargets(bindingForExtensionIndex(index, track)));
    return { main, extension };
  }



  function extensionForMainIndex(index) {
    const binding = bindingForMainIndex(index);
    return binding ? extensionSegmentById(binding.extension_segment_ids?.[0], getExtensionTrack(binding.track_id)) : null;
  }



  function mainIndexForExtensionIndex(index, track = getActiveExtensionTrack()) {
    const segment = track?.segments?.[index];
    if (!segment) return -1;
    const binding = window.AsrEditorUtils.bindingForSegment(getMultiSubtitleState(), segment.id, 'extension', track.id);
    const mainId = binding?.main_segment_ids?.[0];
    return MaweBoot.DATA.segments.findIndex((candidate) => candidate.id === mainId);
  }



  function removeBindingsForSegmentIds(mainIds = [], extensionIds = []) {
    const mainSet = new Set(mainIds.filter(Boolean));
    const extensionSet = new Set(extensionIds.filter(Boolean));
    const multi = getMultiSubtitleState();
    window.AsrEditorUtils.removeSubtitleBindings(multi, (binding) => (
      binding.main_segment_ids?.some((id) => mainSet.has(id))
        || binding.extension_segment_ids?.some((id) => extensionSet.has(id))
    ));
    window.AsrEditorUtils.rebuildBindingOffsets(multi, MaweBoot.DATA.segments);
  }



  function addSubtitleBinding(mainSegment, extensionSegment, track = getActiveExtensionTrack()) {
    if (!mainSegment || !extensionSegment || !track) return null;
    const multi = getMultiSubtitleState();
    removeBindingsForSegmentIds([mainSegment.id], [extensionSegment.id]);
    const binding = window.AsrEditorUtils.buildSubtitleBinding(mainSegment, extensionSegment, track.id);
    multi.bindings.push(binding);
    multi.enabled = true;
    window.AsrEditorUtils.rebuildBindingOffsets(multi, MaweBoot.DATA.segments);
    return binding;
  }



  function markMultiSubtitleStateDirty() {
    const multi = getMultiSubtitleState();
    if (!multi.enabled && !(multi.tracks || []).length) return null;
    multi._dirty = true;
    return multi;
  }



  function markMultiSubtitleDirty() {
    const multi = markMultiSubtitleStateDirty();
    if (!multi) return;
    (multi.tracks || []).forEach((track) => track.segments.forEach((segment) => { segment._dirty = true; }));
  }



  function markMainSegmentsDirty(segments = MaweBoot.DATA.segments) {
    (Array.isArray(segments) ? segments : []).forEach((segment) => {
      if (segment) segment._dirty = true;
    });
  }



  function syncBindingOffsets() {
    window.AsrEditorUtils.rebuildBindingOffsets(getMultiSubtitleState(), MaweBoot.DATA.segments);
  }



  function clampExtensionRange(segment, start, end, duration = MaweCoreState.waveformEditor?.durationMs || Infinity) {
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
    const duration = Number(MaweCoreState.waveformEditor?.durationMs);
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
    segment.items = MaweCuePanel.remapPanelItems(
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
    const selectedIds = active ? new Set([...MaweSelection.selectedExtensionIdxs]
      .map((index) => track.segments[index]?.id)
      .filter(Boolean)) : new Set();
    const currentId = active && MaweCuePanelState.currentCuePanelKind === 'extension'
      && MaweCuePanelState.currentCuePanelTrackId === track.id
      ? track.segments[MaweCuePanelState.currentCuePanelIdx]?.id : null;
    const lastClickedId = active ? track.segments[MaweSelection.lastClickedExtensionIdx]?.id || null : null;
    return { active, selectedIds, currentId, lastClickedId };
  }



  function restoreExtensionTrackSelection(track, snapshot) {
  if (!track || !snapshot?.active) return;
  MaweSelection.selectedExtensionIdxs.clear();
  snapshot.selectedIds.forEach((id) => {
    const index = track.segments.findIndex((segment) => segment?.id === id);
    if (index >= 0) MaweSelection.selectedExtensionIdxs.add(index);
  });
  if (snapshot.currentId && MaweCuePanelState.currentCuePanelKind === 'extension'
      && MaweCuePanelState.currentCuePanelTrackId === track.id) {
    MaweCuePanelState.currentCuePanelIdx = track.segments.findIndex((segment) => segment?.id === snapshot.currentId);
    if (MaweCuePanelState.currentCuePanelIdx < 0) {
      MaweCuePanelState.currentCuePanelKind = 'main';
      MaweCuePanelState.currentCuePanelTrackId = null;
    }
  }
  MaweSelection.lastClickedExtensionIdx = snapshot.lastClickedId
    ? track.segments.findIndex((segment) => segment?.id === snapshot.lastClickedId) : -1;
  updateSelectionCountText();
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
      const removedBindings = window.AsrEditorUtils.removeSubtitleBindings(multi, (binding) => (
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
    MaweHint.flashHint(message, 'warning');
  }



  function syncBoundExtensionForMain(mainSegment, patch = {}) {
    if (!mainSegment || patch.independent || !multiSubtitleVisible()) return false;
    const binding = window.AsrEditorUtils.bindingForSegment(getMultiSubtitleState(), mainSegment.id, 'main');
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
    const binding = window.AsrEditorUtils.bindingForSegment(
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
      MaweBoot.DATA.segments,
    );
    const blocked = constrained.blocked
      || constrained.start !== desiredMainStart
      || constrained.end !== desiredMainEnd;
    const nextStart = oldStart + (constrained.start - main.start);
    const nextEnd = oldEnd + (constrained.end - main.end);
    extension.items = MaweCuePanel.remapPanelItems(extension.items, oldStart, oldEnd, nextStart, nextEnd);
    extension.start = nextStart;
    extension.end = nextEnd;
    main.start = constrained.start;
    main.end = constrained.end;
    main._dirty = true;
    extension._dirty = true;
    return blocked;
  }

  global.MaweMultiSubtitleCore = Object.freeze({
    MULTI_SUBTITLE_TOLERANCE_MS,
    MULTI_SUBTITLE_MERGE_OVERLAP_TOLERANCE_MS,
    SUBTITLE_MIN_DURATION_MS,
    PROJECT_SEGMENT_OVERLAP_AUTO_FIX_MAX_MS,
    MULTI_SUBTITLE_IMPORT_PROMPT,
    MULTI_SUBTITLE_TOGGLE_TITLE,
    get normalizedMultiSubtitleReference() { return normalizedMultiSubtitleReference; },
    set normalizedMultiSubtitleReference(v) { normalizedMultiSubtitleReference = v; },
    get pendingSrtImportAsExtension() { return pendingSrtImportAsExtension; },
    set pendingSrtImportAsExtension(v) { pendingSrtImportAsExtension = v; },
    normalizeMultiSubtitleState,
    getMultiSubtitleState,
    getExtensionTrack,
    getActiveExtensionTrack,
    multiSubtitleVisible,
    isConfiguredSubtitleSplitMode,
    getMainSubtitleSplitMode,
    getExtensionSubtitleSplitMode,
    splitModeLabel,
    splitModeExample,
    mergeJoinSeparatorForMode,
    multiSubtitleWaveformStructureKey,
    mainSegmentById,
    extensionSegmentById,
    bindingForMainIndex,
    bindingForExtensionIndex,
    getBindingMarkerTargets,
    extensionForMainIndex,
    mainIndexForExtensionIndex,
    removeBindingsForSegmentIds,
    addSubtitleBinding,
    markMultiSubtitleStateDirty,
    markMultiSubtitleDirty,
    markMainSegmentsDirty,
    syncBindingOffsets,
    clampExtensionRange,
    clampNumber,
    getSubtitleTimelineDuration,
    getTrackNeighborBounds,
    extensionRangeOverlapsNeighbors,
    setExtensionSegmentRange,
    extensionTrackSelectionSnapshot,
    restoreExtensionTrackSelection,
    sortExtensionTrackSegments,
    reconcileExtensionTrack,
    resolveExtensionFollowerRange,
    constrainCueRangeToTrack,
    notifyBoundSyncWarning,
    syncBoundExtensionForMain,
    constrainBoundExtensionPanelEdit
  });
})(typeof window !== 'undefined' ? window : globalThis);
