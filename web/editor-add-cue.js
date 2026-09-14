// 波形空白处新增主/副字幕。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweAddCue 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweAddCue(global) {
  'use strict';



  // === 从波形空白处新增字幕 ===
  function addExtensionRangeFromWaveform(
    requestedStart,
    requestedEnd,
    clickX,
    clickY,
    track = MaweMultiSubtitleCore.getActiveExtensionTrack(),
  ) {
    const duration = MaweCoreState.waveformEditor?.durationMs || (Number.isFinite(MaweCoreState.player.duration) ? MaweCoreState.player.duration * 1000 : 0);
    if (!duration) { MaweHint.flashHint('媒体时长尚未加载', 'invalid'); return; }
    if (!track?.segments) { MaweHint.flashHint('当前没有可用的副字幕轨', 'invalid'); return; }
    requestedStart = timelineFrameAlignedMilliseconds(requestedStart);
    requestedEnd = timelineFrameAlignedMilliseconds(requestedEnd);
    const start = Math.min(requestedStart, requestedEnd);
    const end = Math.max(requestedStart, requestedEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return;
    if (track.segments.some((segment) => start < segment.end && end > segment.start)) {
      MaweHint.flashHint('拖动范围包含已有副字幕，无法新增副字幕', 'warning');
      return;
    }
    const insertAt = track.segments.findIndex((segment) => segment.start > start);
    const index = insertAt < 0 ? track.segments.length : insertAt;
    const previousEnd = index > 0 ? Number(track.segments[index - 1].end) : 0;
    const nextStart = index < track.segments.length ? Number(track.segments[index].start) : duration;
    const safeStart = Math.max(previousEnd, Math.min(duration, Math.round(start / 10) * 10));
    const safeEnd = Math.min(nextStart, Math.max(safeStart, Math.round(end / 10) * 10));
    if (safeEnd - safeStart < MaweMultiSubtitleCore.SUBTITLE_MIN_DURATION_MS) {
      MaweHint.flashHint('该空白区域不足 100ms，无法新增副字幕', 'warning');
      return;
    }
    MaweCuePanel.commitCuePanelEdit();
    MaweHistory.pushUndo('新增副字幕');
    track.segments.splice(index, 0, {
      id: window.AsrEditorUtils.uniqueStableSegmentId(track.segments, `${track.id}-${index + 1}`, 'extension'),
      start: safeStart,
      end: safeEnd,
      text: '',
      items: [],
      _dirty: true,
    });
    MaweMultiSubtitleCore.markMultiSubtitleDirty();
    MaweSelection.clearSelection({ silent: true });
    MaweCuePanel.renderAll({ preserveCueListScroll: false });
    MaweSelection.selectOnlyExtension(index, track);
    const extensionText = MaweCoreState.container.querySelector(
      `.multi-extension-cue[data-ext-idx="${index}"] .multi-cue-column.extension, `
        + `.multi-dual-cue[data-ext-idx="${index}"] .multi-cue-column.extension`,
    );
    if (extensionText) {
      const cue = extensionText.closest('.cue');
      if (cue) MaweCueListAnchor.scrollCueToCenter(cue);
      setTimeout(() => MaweInlineEdit.startExtensionEdit(extensionText, index, track), 0);
    }
    MaweCoreState.waveformEditor?.revealTime(safeStart, true);
    MaweHint.flashHint(`已新增第 ${index + 1} 条副字幕`, 'success');
  }



  function addCueRangeFromWaveform(requestedStart, requestedEnd, clickX, clickY, track = 'main') {
    if (track === 'extension') {
      addExtensionRangeFromWaveform(requestedStart, requestedEnd, clickX, clickY);
      return;
    }
    const duration = MaweCoreState.waveformEditor?.durationMs || (Number.isFinite(MaweCoreState.player.duration) ? MaweCoreState.player.duration * 1000 : 0);
    if (!duration) { MaweHint.flashHint('媒体时长尚未加载', 'invalid'); return; }
    requestedStart = timelineFrameAlignedMilliseconds(requestedStart);
    requestedEnd = timelineFrameAlignedMilliseconds(requestedEnd);
    const start = Math.min(requestedStart, requestedEnd);
    const end = Math.max(requestedStart, requestedEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return;
    if (MaweBoot.DATA.segments.some((segment) => start < segment.end && end > segment.start)) {
      MaweHint.flashHint('拖动范围包含已有字幕，无法新增字幕', 'warning');
      return;
    }
    const insertAt = MaweBoot.DATA.segments.findIndex((segment) => segment.start > start);
    const index = insertAt < 0 ? MaweBoot.DATA.segments.length : insertAt;
    const previousEnd = index > 0 ? MaweBoot.DATA.segments[index - 1].end : 0;
    const nextStart = index < MaweBoot.DATA.segments.length ? MaweBoot.DATA.segments[index].start : duration;
    const safeStart = Math.max(previousEnd, Math.min(duration, Math.round(start / 10) * 10));
    const safeEnd = Math.min(nextStart, Math.max(safeStart, Math.round(end / 10) * 10));
    if (safeEnd - safeStart < 100) {
      MaweHint.flashHint('该空白区域不足 100ms，无法新增字幕', 'warning');
      return;
    }
    MaweCuePanel.commitCuePanelEdit();
    MaweHistory.pushUndo('新增字幕');
    MaweBoot.DATA.segments.splice(index, 0, {
      id: window.AsrEditorUtils.uniqueStableSegmentId(MaweBoot.DATA.segments, `main-${index + 1}`, 'main'),
      start: safeStart,
      end: safeEnd,
      text: '',
      items: [],
      _dirty: true,
    });
    window.AsrEditorUtils.shiftGroupReferenceIndices(MaweBoot.DATA.segments, index, 1);
    MaweSelection.clearSelection({ silent: true });
    MaweCuePanel.renderAll({ preserveCueListScroll: false });
    MaweSelection.selectOnly(index);
    const cue = MaweCoreState.container.querySelector(`.cue[data-idx="${index}"]`);
    if (cue) {
      MaweCueListAnchor.scrollCueToCenter(cue);
    }
    setTimeout(() => MaweCuePanel.focusCuePanelText(index), 0);
    MaweCoreState.waveformEditor?.revealTime(safeStart, true);
    MaweHint.flashHint(`已新增第 ${index + 1} 条字幕`, 'success');
  }



  function addCueAtWaveformTime(timeMs, clickX, clickY) {
    const duration = MaweCoreState.waveformEditor?.durationMs || (Number.isFinite(MaweCoreState.player.duration) ? MaweCoreState.player.duration * 1000 : 0);
    if (!duration) { MaweHint.flashHint('媒体时长尚未加载', 'invalid'); return; }
    timeMs = timelineFrameAlignedMilliseconds(timeMs);
    if (MaweContextMenus.findWaveformCueAtTime(timeMs) >= 0) {
      MaweHint.flashHint('当前位置已有字幕，请使用“按音频位置拆分当前字幕”', 'invalid');
      return;
    }
    const insertAt = MaweBoot.DATA.segments.findIndex((segment) => segment.start > timeMs);
    const index = insertAt < 0 ? MaweBoot.DATA.segments.length : insertAt;
    const previousEnd = index > 0 ? MaweBoot.DATA.segments[index - 1].end : 0;
    const nextStart = index < MaweBoot.DATA.segments.length ? MaweBoot.DATA.segments[index].start : duration;
    if (timeMs < previousEnd) {
      MaweHint.flashHint('当前位置已有字幕，请使用“按音频位置拆分当前字幕”', 'invalid');
      return;
    }
    const gap = nextStart - previousEnd;
    if (gap < 100) {
      MaweHint.flashHint('这里没有足够的空白区域', 'warning');
      return;
    }
    const start = Math.max(previousEnd, Math.min(Math.round(timeMs / 10) * 10, nextStart - 100));
    const end = Math.min(nextStart, start + 1000);
    const adjustedStart = end - start >= 100 ? start : Math.max(previousEnd, nextStart - 1000);
    addCueRangeFromWaveform(adjustedStart, end, clickX, clickY);
  }



  function addExtensionAtWaveformTime(timeMs, clickX, clickY, track = MaweMultiSubtitleCore.getActiveExtensionTrack()) {
    const duration = MaweCoreState.waveformEditor?.durationMs || (Number.isFinite(MaweCoreState.player.duration) ? MaweCoreState.player.duration * 1000 : 0);
    if (!duration) { MaweHint.flashHint('媒体时长尚未加载', 'invalid'); return; }
    timeMs = timelineFrameAlignedMilliseconds(timeMs);
    if (!track || !Array.isArray(track.segments)) {
      MaweHint.flashHint('当前没有可用的副字幕轨', 'invalid');
      return;
    }
    const insertAt = track.segments.findIndex((segment) => Number(segment.start) > timeMs);
    const index = insertAt < 0 ? track.segments.length : insertAt;
    const previousEnd = index > 0 ? Number(track.segments[index - 1].end) : 0;
    const nextStart = index < track.segments.length ? Number(track.segments[index].start) : duration;
    if (timeMs < previousEnd || timeMs > nextStart) {
      MaweHint.flashHint('当前位置已有副字幕，请先调整相邻字幕时间', 'invalid');
      return;
    }
    const gap = nextStart - previousEnd;
    if (gap < 100) {
      MaweHint.flashHint('这里没有足够的空白区域', 'warning');
      return;
    }
    const start = Math.max(previousEnd, Math.min(Math.round(timeMs / 10) * 10, nextStart - 100));
    const end = Math.min(nextStart, start + 1000);
    const adjustedStart = end - start >= 100 ? start : Math.max(previousEnd, nextStart - 1000);
    if (end - adjustedStart < 100) {
      MaweHint.flashHint('这里没有足够的空白区域', 'warning');
      return;
    }
    MaweHistory.pushUndo('新增副字幕');
    const segment = {
      id: window.AsrEditorUtils.uniqueStableSegmentId(
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
    MaweMultiSubtitleCore.markMultiSubtitleDirty();
    MaweSelection.clearSelection();
    MaweCuePanel.renderAll({ preserveCueListScroll: false });
    MaweSelection.selectOnlyExtension(index);
    const extensionText = MaweCoreState.container.querySelector(
      `.multi-extension-cue[data-ext-idx="${index}"] .multi-cue-column.extension, `
        + `.multi-dual-cue[data-ext-idx="${index}"] .multi-cue-column.extension`,
    );
    if (extensionText) {
      const cue = extensionText.closest('.cue');
      if (cue) MaweCueListAnchor.scrollCueToCenter(cue);
      setTimeout(() => MaweInlineEdit.startExtensionEdit(extensionText, index, track), 0);
    }
    MaweCoreState.waveformEditor?.revealTime(adjustedStart, true);
    MaweHint.flashHint(`已新增第 ${index + 1} 条副字幕`, 'success');
  }

  global.MaweAddCue = Object.freeze({
    addExtensionRangeFromWaveform,
    addCueRangeFromWaveform,
    addCueAtWaveformTime,
    addExtensionAtWaveformTime
  });
})(typeof window !== 'undefined' ? window : globalThis);
