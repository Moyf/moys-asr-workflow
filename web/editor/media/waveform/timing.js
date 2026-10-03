// timing: waveform helpers with explicit dependencies.
window.MAWE.register('waveform-timing', function createWaveformModule(dependencies) {
  'use strict';
  const { MIN_CUE_MS, ROUND_MS, SNAP_MS, clamp } = dependencies;


  function roundMs(value) {
    return Math.round(value / ROUND_MS) * ROUND_MS;
  }


  function formatCompact(ms) {
    const safe = Math.max(0, Math.round(ms));
    const hours = Math.floor(safe / 3600000);
    const minutes = Math.floor((safe % 3600000) / 60000);
    const seconds = Math.floor((safe % 60000) / 1000);
    const millis = safe % 1000;
    const hh = hours ? `${String(hours).padStart(2, '0')}:` : '';
    return `${hh}${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
  }


  // 字幕编辑操作可以使用毫秒或工程提供的帧时间轴。波形的绘制和播放头
  // 仍然使用毫秒；这里的适配器只负责字幕块的读写、约束和字词映射。
  function resolveTiming(timing = null) {
    const source = timing && typeof timing === 'object' ? timing : {};
    const positive = (value, fallback) => (
      Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback
    );
    const frameMode = source.unit === 'frames';
    return {
      unit: frameMode ? 'frames' : 'milliseconds',
      fps: positive(source.fps, 30),
      minDuration: positive(source.minDuration, MIN_CUE_MS),
      snapThreshold: positive(source.snapThreshold, SNAP_MS),
      round: typeof source.round === 'function' ? source.round : roundMs,
      getStart: typeof source.getStart === 'function'
        ? source.getStart : (segment) => Number(segment?.start),
      getEnd: typeof source.getEnd === 'function'
        ? source.getEnd : (segment) => Number(segment?.end),
      setStart: typeof source.setStart === 'function'
        ? source.setStart : (segment, value) => { segment.start = value; },
      setEnd: typeof source.setEnd === 'function'
        ? source.setEnd : (segment, value) => { segment.end = value; },
      getItemStart: typeof source.getItemStart === 'function'
        ? source.getItemStart : (item) => Number(item?.start),
      getItemEnd: typeof source.getItemEnd === 'function'
        ? source.getItemEnd : (item) => Number(item?.end),
      setItemStart: typeof source.setItemStart === 'function'
        ? source.setItemStart : (item, value) => { item.start = value; },
      setItemEnd: typeof source.setItemEnd === 'function'
        ? source.setItemEnd : (item, value) => { item.end = value; },
      fromMs: typeof source.fromMs === 'function'
        ? source.fromMs : (value) => Number(value),
      toMs: typeof source.toMs === 'function'
        ? source.toMs : (value) => Number(value),
      format: typeof source.format === 'function' ? source.format : formatCompact,
    };
  }


  function waveformGridStepMs(timing = null) {
    const clock = resolveTiming(timing);
    return clock.unit === 'frames' ? 1000 / clock.fps : 100;
  }


  function snapPointerTimeToTimingGrid(valueMs, timing = null, enabled = false) {
    const numeric = Number(valueMs);
    if (!Number.isFinite(numeric)) return numeric;
    const clock = resolveTiming(timing);
    if (!enabled || clock.unit !== 'frames') return numeric;
    return clock.toMs(clock.fromMs(numeric));
  }


  function restoreTiming(segment, original, timing = null) {
    const clock = resolveTiming(timing);
    if (!segment || !original) return;
    clock.setStart(segment, original.start);
    clock.setEnd(segment, original.end);
    segment.items = Array.isArray(original.items)
      ? original.items.map((item) => ({ ...item })) : original.items;
  }


  function applySharedBoundary(
    segments,
    leftIndex,
    boundary,
    minDuration = MIN_CUE_MS,
    timing = null,
  ) {
    const clock = resolveTiming(timing);
    const left = segments[leftIndex];
    const right = segments[leftIndex + 1];
    if (!left || !right) return segments;
    const lower = clock.getStart(left) + minDuration;
    const upper = clock.getEnd(right) - minDuration;
    const nextBoundary = clamp(clock.round(boundary), lower, upper);
    const oldLeftEnd = clock.getEnd(left);
    const oldRightStart = clock.getStart(right);
    const leftStart = clock.getStart(left);
    const rightEnd = clock.getEnd(right);
    clock.setEnd(left, nextBoundary);
    clock.setStart(right, nextBoundary);
    left.items = remapItems(left.items, leftStart, oldLeftEnd, leftStart, nextBoundary, clock);
    right.items = remapItems(right.items, oldRightStart, rightEnd, nextBoundary, rightEnd, clock);
    return segments;
  }


  // Alt-drag a shared resize handle moves ONLY the hit side, leaving the
  // neighboring segment's opposite edge untouched. This is the independent
  // counterpart to applySharedBoundary, which moves both sides linked.
  // edge === 'end' moves segments[leftIndex].end; 'start' moves
  // segments[leftIndex + 1].start. The moved edge is clamped to keep at
  // least minDuration inside its own segment and not cross its other edge.
  function applyIndependentEdge(
    segments,
    leftIndex,
    edge,
    valueMs,
    minDuration = MIN_CUE_MS,
    timing = null,
  ) {
    const clock = resolveTiming(timing);
    const left = segments[leftIndex];
    const right = segments[leftIndex + 1];
    if (!left || !right || (edge !== 'end' && edge !== 'start')) return segments;
    const value = clock.round(valueMs);
    if (edge === 'end') {
      const lower = clock.getStart(left) + minDuration;
      // 右侧字幕保持不动；使用它的起点作为固定上限，不能把当前值
      // 当作上限，否则边界第一次向左拉开后就无法再向右回拖。
      const upper = Number.isFinite(clock.getStart(right)) ? clock.getStart(right) : Infinity;
      const next = clamp(value, lower, upper);
      const oldEnd = clock.getEnd(left);
      const leftStart = clock.getStart(left);
      clock.setEnd(left, next);
      left.items = remapItems(left.items, leftStart, oldEnd, leftStart, next, clock);
    } else {
      const upper = clock.getEnd(right) - minDuration;
      // 左侧字幕保持不动；使用它的终点作为固定下限，同样允许边界
      // 在拉开后反向回到邻字幕边界。
      const lower = Number.isFinite(clock.getEnd(left)) ? clock.getEnd(left) : 0;
      const next = clamp(value, lower, upper);
      const oldStart = clock.getStart(right);
      const rightEnd = clock.getEnd(right);
      clock.setStart(right, next);
      right.items = remapItems(right.items, oldStart, rightEnd, next, rightEnd, clock);
    }
    return segments;
  }


  function snapshotTiming(segment, timing = null) {
    const clock = resolveTiming(timing);
    const start = clock.getStart(segment);
    const end = clock.getEnd(segment);
    const startMs = Number(segment?.start);
    const endMs = Number(segment?.end);
    return {
      start: Number(start),
      end: Number(end),
      startMs: Number.isFinite(startMs) ? startMs : clock.toMs(start),
      endMs: Number.isFinite(endMs) ? endMs : clock.toMs(end),
      items: Array.isArray(segment.items)
        ? segment.items.map((item) => ({ ...item })) : segment.items,
    };
  }


  function isAttached(left, right, timing = null) {
    const clock = resolveTiming(timing);
    return !!left && !!right && clock.getEnd(left) === clock.getStart(right);
  }


  function shouldAdjustAdjacentCuesIndependently(altKey, autoSnapAdjacentCues) {
    // Alt 始终临时反转自动吸附开关；开关关闭且未按 Alt 时也是独立调整。
    return Boolean(altKey) === Boolean(autoSnapAdjacentCues);
  }


  // 相接字幕边界手柄的拖动方式：
  // - dual（新默认，达芬奇式）：手柄始终独立调整单侧，联动交给中缝拖动区；
  // - classic（传统）：沿用“自动吸附调整相邻字幕”开关 + Alt 临时反转。
  function shouldAdjustSharedBoundaryHandleIndependently(altKey, autoSnapAdjacentCues, boundaryMode) {
    if (boundaryMode === 'dual') return true;
    return shouldAdjustAdjacentCuesIndependently(altKey, autoSnapAdjacentCues);
  }


  function normalizedIndices(segments, indices) {
    return [...new Set(Array.from(indices || [])
      .map((idx) => Number(idx))
      .filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < segments.length))]
      .sort((a, b) => a - b);
  }


  // Keyboard movement is a small, discrete counterpart to moving a waveform
  // block. When adjacent-cue auto snapping is active and the selected range is
  // attached to a neighboring cue, the shared boundary follows the moved
  // range. The Alt modifier temporarily reverses that choice.
  function planMoveStep(segments, indices, deltaMs, durationMs, {
    sticky = true,
    minDuration = MIN_CUE_MS,
    timing = null,
  } = {}) {
    const clock = resolveTiming(timing);
    const selectedIndices = normalizedIndices(segments, indices);
    if (!selectedIndices.length) {
      return { changed: false, appliedDelta: 0, indices: [], affectedIndices: [] };
    }
    const selected = new Set(selectedIndices);
    const originals = new Map(selectedIndices.map((idx) => [idx, snapshotTiming(segments[idx], clock)]));
    const attachments = [];
    const attachmentOriginals = new Map();
    const previousAttachments = [];
    const previousAttachmentOriginals = new Map();
    let minDelta = -Infinity;
    let maxDelta = Infinity;
    const timelineDuration = Number(durationMs);

    for (const idx of selectedIndices) {
      const original = originals.get(idx);
      minDelta = Math.max(minDelta, -original.start);
      if (Number.isFinite(timelineDuration) && timelineDuration > 0) {
        maxDelta = Math.min(maxDelta, timelineDuration - original.end);
      }
      const previous = segments[idx - 1];
      if (previous && !selected.has(idx - 1)) {
        if (sticky && isAttached(previous, segments[idx], clock)) {
          const previousOriginal = snapshotTiming(previous, clock);
          previousAttachments.push({ index: idx, previousIndex: idx - 1 });
          previousAttachmentOriginals.set(idx - 1, previousOriginal);
          minDelta = Math.max(minDelta, previousOriginal.start + minDuration - original.start);
        } else {
          minDelta = Math.max(minDelta, clock.getEnd(previous) - original.start);
        }
      }
      const next = segments[idx + 1];
      if (!next || selected.has(idx + 1)) continue;
      if (sticky && isAttached(segments[idx], next, clock)) {
        const nextOriginal = snapshotTiming(next, clock);
        attachments.push({ index: idx, nextIndex: idx + 1 });
        attachmentOriginals.set(idx + 1, nextOriginal);
        // The next cue's start follows the selected cue's end, so its end
        // and minimum duration limit how far the shared boundary can move.
        maxDelta = Math.min(maxDelta, nextOriginal.end - minDuration - original.end);
      } else {
        // An unlinked following cue stays fixed and may not be overlapped.
        maxDelta = Math.min(maxDelta, clock.getStart(next) - original.end);
      }
    }

    const requested = Number(deltaMs);
    const rounded = Number.isFinite(requested) ? clock.round(requested) : 0;
    const appliedDelta = clamp(rounded, minDelta, maxDelta);
    const affectedIndices = [...selectedIndices];
    attachments.forEach(({ nextIndex }) => affectedIndices.push(nextIndex));
    previousAttachments.forEach(({ previousIndex }) => affectedIndices.push(previousIndex));
    return {
      changed: appliedDelta !== 0,
      appliedDelta,
      indices: selectedIndices,
      affectedIndices: [...new Set(affectedIndices)].sort((a, b) => a - b),
      originals,
      attachments,
      attachmentOriginals,
      previousAttachments,
      previousAttachmentOriginals,
    };
  }


  function applyMoveStep(segments, indices, deltaMs, durationMs, options = {}) {
    const plan = planMoveStep(segments, indices, deltaMs, durationMs, options);
    if (!plan.changed) return plan;
    const clock = resolveTiming(options.timing);
    const delta = plan.appliedDelta;
    plan.indices.forEach((idx) => {
      const original = plan.originals.get(idx);
      const segment = segments[idx];
      clock.setStart(segment, original.start + delta);
      clock.setEnd(segment, original.end + delta);
      if (Array.isArray(original.items)) {
        segment.items = original.items.map((item) => {
          const copy = { ...item };
          clock.setItemStart(copy, clock.getItemStart(item) + delta);
          clock.setItemEnd(copy, clock.getItemEnd(item) + delta);
          return copy;
        });
      }
    });
    plan.attachments.forEach(({ nextIndex }) => {
      const original = plan.attachmentOriginals.get(nextIndex);
      const segment = segments[nextIndex];
      clock.setStart(segment, original.start + delta);
      segment.items = remapItems(
        original.items,
        original.start,
        original.end,
        clock.getStart(segment),
        clock.getEnd(segment),
        clock,
      );
    });
    plan.previousAttachments.forEach(({ previousIndex }) => {
      const original = plan.previousAttachmentOriginals.get(previousIndex);
      const segment = segments[previousIndex];
      clock.setEnd(segment, original.end + delta);
      segment.items = remapItems(
        original.items,
        original.start,
        original.end,
        clock.getStart(segment),
        clock.getEnd(segment),
        clock,
      );
    });
    return plan;
  }


  function planBoundaryStep(segments, index, edge, deltaMs, durationMs, {
    sticky = true,
    minDuration = MIN_CUE_MS,
    timing = null,
  } = {}) {
    const clock = resolveTiming(timing);
    const target = segments[index];
    if (!target || (edge !== 'start' && edge !== 'end')) {
      return { changed: false, appliedDelta: 0, indices: [], affectedIndices: [] };
    }
    const previous = segments[index - 1];
    const next = segments[index + 1];
    const linkedNeighbor = edge === 'start'
      ? (sticky && isAttached(previous, target, clock) ? previous : null)
      : (sticky && isAttached(target, next, clock) ? next : null);
    const current = edge === 'start' ? clock.getStart(target) : clock.getEnd(target);
    const requested = Number(deltaMs);
    const rounded = Number.isFinite(requested) ? clock.round(requested) : 0;
    let lower;
    let upper;
    if (edge === 'start') {
      lower = linkedNeighbor ? clock.getStart(previous) + minDuration : Number(previous ? clock.getEnd(previous) : 0);
      upper = clock.getEnd(target) - minDuration;
    } else {
      lower = clock.getStart(target) + minDuration;
      upper = linkedNeighbor
        ? clock.getEnd(next) - minDuration
        : Number(next ? clock.getStart(next) : durationMs);
      if (!Number.isFinite(upper) || upper <= 0) upper = Infinity;
    }
    const appliedDelta = clamp(current + rounded, lower, upper) - current;
    const affectedIndices = linkedNeighbor
      ? [index, edge === 'start' ? index - 1 : index + 1].sort((a, b) => a - b)
      : [index];
    const snapshots = new Map(affectedIndices.map((idx) => [idx, snapshotTiming(segments[idx], clock)]));
    return {
      changed: appliedDelta !== 0,
      appliedDelta,
      index,
      edge,
      linked: !!linkedNeighbor,
      neighborIndex: linkedNeighbor ? (edge === 'start' ? index - 1 : index + 1) : -1,
      affectedIndices,
      snapshots,
    };
  }


  function applyBoundaryStep(segments, index, edge, deltaMs, durationMs, options = {}) {
    const plan = planBoundaryStep(segments, index, edge, deltaMs, durationMs, options);
    if (!plan.changed) return plan;
    const clock = resolveTiming(options.timing);
    const target = segments[plan.index];
    const oldTarget = plan.snapshots.get(plan.index);
    const value = (plan.edge === 'start' ? oldTarget.start : oldTarget.end) + plan.appliedDelta;
    if (plan.edge === 'start') {
      clock.setStart(target, value);
      target.items = remapItems(
        oldTarget.items, oldTarget.start, oldTarget.end,
        clock.getStart(target), clock.getEnd(target), clock,
      );
      if (plan.linked) {
        const previous = segments[plan.neighborIndex];
        const oldPrevious = plan.snapshots.get(plan.neighborIndex);
        clock.setEnd(previous, value);
        previous.items = remapItems(
          oldPrevious.items, oldPrevious.start, oldPrevious.end,
          clock.getStart(previous), clock.getEnd(previous), clock,
        );
      }
    } else {
      clock.setEnd(target, value);
      target.items = remapItems(
        oldTarget.items, oldTarget.start, oldTarget.end,
        clock.getStart(target), clock.getEnd(target), clock,
      );
      if (plan.linked) {
        const next = segments[plan.neighborIndex];
        const oldNext = plan.snapshots.get(plan.neighborIndex);
        clock.setStart(next, value);
        next.items = remapItems(
          oldNext.items, oldNext.start, oldNext.end,
          clock.getStart(next), clock.getEnd(next), clock,
        );
      }
    }
    return plan;
  }


  // Safe split point selection for the razor tool. Given a segment and a
  // pointer time, prefer the nearest item boundary (midpoint between adjacent
  // items' end/start); otherwise fall back to the integer millisecond nearest
  // the pointer. Refuse any split within minEdge of either segment edge so a
  // razor click never produces a sub-100ms sliver. Returns { left, right,
  // splitMs } with cloned items allocated by time, or null when refused.
  function splitSegmentAtTime(segment, timeMs, minEdge = MIN_CUE_MS) {
    if (!segment) return null;
    const start = Math.round(Number(segment.start));
    const end = Math.round(Number(segment.end));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < minEdge * 2) return null;
    const target = Number.isFinite(Number(timeMs)) ? Number(timeMs) : (start + end) / 2;

    const items = Array.isArray(segment.items) ? segment.items : [];
    // Collect candidate item-boundary times (midpoint between adjacent items).
    const boundaries = [];
    for (let i = 1; i < items.length; i++) {
      const prevEnd = Number(items[i - 1].end);
      const nextStart = Number(items[i].start);
      if (Number.isFinite(prevEnd) && Number.isFinite(nextStart)) {
        boundaries.push(Math.round((prevEnd + nextStart) / 2));
      }
    }
    let splitMs;
    if (boundaries.length) {
      splitMs = boundaries.reduce((best, value) => (
        Math.abs(value - target) <= Math.abs(best - target) ? value : best
      ), boundaries[0]);
    } else {
      splitMs = Math.round(target);
    }
    splitMs = clamp(splitMs, start + minEdge, end - minEdge);
    if (splitMs <= start + minEdge - 1 || splitMs >= end - minEdge + 1) return null;

    const leftItems = [];
    const rightItems = [];
    for (const item of items) {
      const itemStart = Number(item.start);
      const itemEnd = Number(item.end);
      // An item straddling the split snaps to the side whose start is closer.
      if (Number.isFinite(itemEnd) && itemEnd <= splitMs) {
        leftItems.push({ ...item });
      } else if (Number.isFinite(itemStart) && itemStart >= splitMs) {
        rightItems.push({ ...item });
      } else if (Number.isFinite(itemStart) && Number.isFinite(itemEnd)) {
        // 跨越切点的 item 归入更近的一侧，并把时间钳到该侧边界内，
        // 避免 item 越出所属段导致保存校验失败。
        if (splitMs - itemStart <= itemEnd - splitMs) {
          leftItems.push({ ...item, end: Math.min(itemEnd, splitMs) });
        } else {
          rightItems.push({ ...item, start: Math.max(itemStart, splitMs) });
        }
      } else {
        leftItems.push({ ...item });
      }
    }

    const clone = (base) => ({ ...base });
    const left = clone(segment);
    const right = clone(segment);
    left.start = start;
    left.end = splitMs;
    right.start = splitMs;
    right.end = end;
    left.items = leftItems.length ? leftItems : null;
    right.items = rightItems.length ? rightItems : null;
    left._dirty = true;
    right._dirty = true;
    return { left, right, splitMs };
  }


  function normalizeNewCueRange(start, end, duration, previousEnd = 0, nextStart = duration, minDuration = MIN_CUE_MS) {
    const lower = clamp(roundMs(previousEnd), 0, Math.max(0, duration));
    const upper = clamp(roundMs(nextStart), lower, Math.max(lower, duration));
    const nextStartMs = clamp(roundMs(start), lower, upper);
    const nextEndMs = clamp(roundMs(end), lower, upper);
    if (nextEndMs - nextStartMs < minDuration) return null;
    return { start: nextStartMs, end: nextEndMs };
  }


  function remapItems(items, oldStart, oldEnd, newStart, newEnd, timing = null) {
    if (!Array.isArray(items) || !items.length) return items;
    const clock = resolveTiming(timing);
    const oldDuration = Math.max(1, oldEnd - oldStart);
    const newDuration = Math.max(1, newEnd - newStart);
    return items.map((item) => {
      // 等比缩放后钳回段内，并保证 end > start（防止取整后出现 0 长词块）。
      const itemStart = clock.getItemStart(item);
      const itemEnd = clock.getItemEnd(item);
      const mappedStart = clock.round(newStart + ((itemStart - oldStart) / oldDuration) * newDuration);
      const mappedEnd = clock.round(newStart + ((itemEnd - oldStart) / oldDuration) * newDuration);
      let start = Math.min(Math.max(mappedStart, newStart), newEnd);
      const end = Math.min(Math.max(mappedEnd, start + 1), newEnd);
      if (end <= start) start = Math.max(newStart, end - 1);
      const copy = { ...item };
      clock.setItemStart(copy, start);
      clock.setItemEnd(copy, end);
      return copy;
    });
  }

  return Object.freeze({ applyBoundaryStep, applyIndependentEdge, applyMoveStep, applySharedBoundary, formatCompact, isAttached, normalizeNewCueRange, normalizedIndices, planBoundaryStep, planMoveStep, remapItems, resolveTiming, restoreTiming, roundMs, shouldAdjustAdjacentCuesIndependently, shouldAdjustSharedBoundaryHandleIndependently, snapPointerTimeToTimingGrid, snapshotTiming, splitSegmentAtTime, waveformGridStepMs });
});
