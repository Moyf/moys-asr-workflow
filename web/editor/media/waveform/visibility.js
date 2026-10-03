// visibility: waveform helpers with explicit dependencies.
window.MAWE.register('waveform-visibility', function createWaveformModule(dependencies) {
  'use strict';
  const { ROW_GAP, clamp } = dependencies;


  function isMultiRowInComfortZone(rowIndex, scrollTop, viewportHeight, rowHeight) {
    const safeRowHeight = Math.max(1, Number(rowHeight) || 0);
    const safeViewportHeight = Math.max(1, Number(viewportHeight) || 0);
    const safeScrollTop = Number.isFinite(Number(scrollTop)) ? Number(scrollTop) : 0;
    const rowTop = Number(rowIndex) * (safeRowHeight + ROW_GAP) - safeScrollTop;
    const comfortInset = Math.min(120, Math.max(48, safeViewportHeight * 0.2));
    return rowTop >= comfortInset
      && rowTop + safeRowHeight <= safeViewportHeight - comfortInset;
  }


  function waveformTopEdgeMs(state) {
    if (state?.mode === 'basic') return Math.max(0, Math.round(Number(state.basicWindowStartMs) || 0));
    const scrollTop = Math.max(0, Number(state?.scrollTop) || 0);
    const stride = Math.max(1, Number(state?.rowHeight) + Number(state?.rowGap));
    const rowDurationMs = Math.max(1, Number(state?.secondsPerRow) * 1000 || 1);
    return Math.max(0, Math.floor(scrollTop / stride) * rowDurationMs);
  }


  function restoreWaveformTopEdgeMs(state, value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) return null;
    const durationMs = Math.max(0, Math.round(Number(state?.durationMs) || 0));
    if (state?.mode === 'basic') {
      const windowMs = Math.max(1, Number(state.visibleSeconds) * 1000 || 1);
      return clamp(value, 0, Math.max(0, durationMs - windowMs));
    }
    const rowDurationMs = Math.max(1, Number(state?.secondsPerRow) * 1000 || 1);
    return Math.floor(Math.min(value, durationMs) / rowDurationMs) * rowDurationMs;
  }


  // 组序号徽章：颜色与表情包分组彼此独立，因此同一条字幕可同时拥有两枚徽章。
  // 颜色组大小 <2 时不显示；表情包即使只有单条也显示 🦊 作为非视觉化标记。
  function computeGroupBadges(segments) {
    const badges = new Map();
    const apply = (type, headField, refField) => {
      // 每个波形行都会使用同一份徽章数据；按 head 建索引，避免每个 head
      // 再扫描整个字幕数组，长工程或多行缓存下可从 O(N²) 降到 O(N)。
      const membersByHead = new Map();
      segments.forEach((seg, headIdx) => {
        if (seg[headField]) membersByHead.set(headIdx, [headIdx]);
      });
      segments.forEach((seg, idx) => {
        const headIdx = seg[refField]?.headIdx;
        const members = membersByHead.get(headIdx);
        if (members && headIdx !== idx) members.push(idx);
      });
      membersByHead.forEach((members) => {
        if (type === 'color' && members.length < 2) return;
        members.forEach((idx, i) => {
          const cueBadges = badges.get(idx) || [];
          cueBadges.push({ type, ordinal: i + 1, total: members.length });
          badges.set(idx, cueBadges);
        });
      });
    };
    apply('color', 'color', 'color_ref');
    apply('sticker', 'sticker', 'sticker_ref');
    return badges;
  }


  // 与字幕列表保持一致：相邻字幕共用边界时，边界属于后一条；间隙和最后一条
  // 的结束时刻仍沿用当前字幕作为播放头对应项。
  function isActiveCueAtTime(segments, index, timeMs, skipDisabled = true) {
    const segment = segments[index];
    if (!segment || (skipDisabled && segment.disabled) || timeMs < Number(segment.start)) return false;
    let next = null;
    for (let nextIndex = index + 1; nextIndex < segments.length; nextIndex += 1) {
      if (!skipDisabled || !segments[nextIndex]?.disabled) {
        next = segments[nextIndex];
        break;
      }
    }
    return timeMs < Number(segment.end) || !next || Number(next.start) > timeMs;
  }


  function lastCueIndexAtOrBefore(segments, timeMs) {
    let low = 0;
    let high = segments.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      const start = Number(segments[middle]?.start);
      if (Number.isFinite(start) && start <= timeMs) low = middle + 1;
      else high = middle;
    }
    return low - 1;
  }


  // 波形块的 active 轮廓是纯视觉提示：只有播放头真正落在 [start, end) 内才点亮。
  // 空隙中沿用的“当前字幕”（导航 / 逻辑语义，见 isActiveCueAtTime）不点亮轮廓。
  function isActiveCueVisualHit(segments, index, timeMs) {
    const segment = segments[index];
    const time = Number(timeMs);
    return Boolean(segment) && Number(segment.start) <= time && time < Number(segment.end);
  }


  function firstCueIndexOverlapping(segments, startMs) {
    let low = 0;
    let high = segments.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      const start = Number(segments[middle]?.start);
      if (Number.isFinite(start) && start < startMs) low = middle + 1;
      else high = middle;
    }
    if (low > 0 && Number(segments[low - 1]?.end) > startMs) return low - 1;
    return low;
  }


  function cueBlockContinuationEdges(segment, startMs, endMs) {
    const segmentStart = Number(segment?.start);
    const segmentEnd = Number(segment?.end);
    const rowStart = Number(startMs);
    const rowEnd = Number(endMs);
    return {
      fromPreviousRow: Number.isFinite(segmentStart) && Number.isFinite(rowStart) && segmentStart < rowStart,
      toNextRow: Number.isFinite(segmentEnd) && Number.isFinite(rowEnd) && segmentEnd > rowEnd,
    };
  }


  function findActiveCueIndex(segments, timeMs, skipDisabled = true) {
    if (!Array.isArray(segments) || !segments.length || !Number.isFinite(Number(timeMs))) return -1;
    let index = lastCueIndexAtOrBefore(segments, Number(timeMs));
    if (skipDisabled) {
      while (index >= 0 && segments[index]?.disabled) index -= 1;
    }
    return index >= 0 && isActiveCueAtTime(segments, index, Number(timeMs), skipDisabled)
      ? index : -1;
  }


  function syncSpectralColorToggle(toggle, available, preferred, busy = false) {
    if (!toggle) return;
    const hasSpectral = Boolean(available);
    const isBusy = Boolean(busy);
    toggle.disabled = !hasSpectral || isBusy;
    toggle.checked = hasSpectral && preferred === true;
    if (typeof toggle.setAttribute === 'function') {
      toggle.setAttribute('aria-disabled', String(!hasSpectral || isBusy));
      toggle.setAttribute('aria-busy', String(isBusy));
    }
  }

  return Object.freeze({ computeGroupBadges, cueBlockContinuationEdges, findActiveCueIndex, firstCueIndexOverlapping, isActiveCueVisualHit, isMultiRowInComfortZone, restoreWaveformTopEdgeMs, syncSpectralColorToggle, waveformTopEdgeMs });
});
