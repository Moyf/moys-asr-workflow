// segment-timing: private helpers; dependencies are injected by editor-utils.js.
window.MAWE.register('utils-segment-timing', function createUtilsModule(dependencies) {
  'use strict';
  const { isShortSubtitleText, normalizeTimedTextNeutralItems } = dependencies;


  // 时长兜底（与 maw/project.py 的 repair_segment_durations 同规则，原地修改）：
  // 任何 0 长（或倒挂）的段 / item 至少保留 minMs，且保持单调不重叠、item 不越出
  // 所属段。只修改非法值，本已合法的短时长时间码（如真实的 60ms 词）保持不动。
  // 返回修复的边界数量。
  function normalizeSegmentTimings(segments, minMs = 100) {
    const floor = Math.max(1, Math.round(Number(minMs) || 100));
    const source = Array.isArray(segments) ? segments : [];
    let fixed = 0;
    let previousSegmentEnd = 0;
    source.forEach((segment) => {
      if (!segment || typeof segment !== 'object') return;
      let start = Math.round(Number(segment.start));
      let end = Math.round(Number(segment.end));
      if (!Number.isFinite(start)) start = 0;
      if (!Number.isFinite(end)) end = start;
      if (start < previousSegmentEnd) { start = previousSegmentEnd; fixed++; }
      fixed += normalizeTimedTextNeutralItems(segment);
      const items = Array.isArray(segment.items) ? segment.items : null;
      let previousItemEnd = start;
      if (items) {
        items.forEach((item) => {
          if (!item || typeof item !== 'object') return;
          let itemStart = Math.round(Number(item.start));
          let itemEnd = Math.round(Number(item.end));
          if (!Number.isFinite(itemStart)) itemStart = previousItemEnd;
          if (!Number.isFinite(itemEnd)) itemEnd = itemStart;
          if (itemStart < previousItemEnd) { itemStart = previousItemEnd; fixed++; }
          if (itemEnd <= itemStart) { itemEnd = itemStart + floor; fixed++; }
          item.start = itemStart;
          item.end = itemEnd;
          previousItemEnd = itemEnd;
        });
        const lastEnd = items.length ? items[items.length - 1].end : null;
        if (Number.isFinite(lastEnd) && end < lastEnd) { end = lastEnd; fixed++; }
      }
      if (end <= start) { end = start + floor; fixed++; }
      segment.start = start;
      segment.end = end;
      previousSegmentEnd = end;
    });
    return fixed;
  }


  // 保存前只修复段内 item 的顺序和零时长，不改动字幕段本身的范围。
  // 这样可以自动处理波形取整造成的 1ms 字/词时间码重叠，同时把真正的
  // 字幕段重叠交给服务端严格校验。
  function normalizeItemTimingRanges(segments, minMs = 100) {
    const floor = Math.max(1, Math.round(Number(minMs) || 100));
    const source = Array.isArray(segments) ? segments : [];
    let fixed = 0;
    source.forEach((segment) => {
      if (!segment || typeof segment !== 'object') return;
      fixed += normalizeTimedTextNeutralItems(segment);
      let previousItemEnd = Math.round(Number(segment.start));
      if (!Number.isFinite(previousItemEnd)) previousItemEnd = 0;
      const items = Array.isArray(segment.items) ? segment.items : null;
      if (!items) return;
      items.forEach((item) => {
        if (!item || typeof item !== 'object') return;
        let itemStart = Math.round(Number(item.start));
        let itemEnd = Math.round(Number(item.end));
        if (!Number.isFinite(itemStart)) { itemStart = previousItemEnd; fixed++; }
        if (!Number.isFinite(itemEnd)) { itemEnd = itemStart; fixed++; }
        if (itemStart < previousItemEnd) { itemStart = previousItemEnd; fixed++; }
        if (itemEnd <= itemStart) { itemEnd = itemStart + floor; fixed++; }
        item.start = itemStart;
        item.end = itemEnd;
        previousItemEnd = itemEnd;
      });
    });
    return fixed;
  }


  // 帧模式下，多个字词可能因为帧率取整而落在同一帧。它们的 frame
  // 字段可以合法地重合，但保存用的毫秒兼容字段仍必须保持在字幕段内、
  // 按 item 顺序排列；不能交给通用修复器按 100ms 向后扩张。
  // 尽量保留帧投影出的毫秒范围，发生碰撞时只压缩到段内剩余空间。
  function normalizeFrameItemTimingRanges(segment) {
    if (!segment || typeof segment !== 'object' || !Array.isArray(segment.items)) return 0;
    const segmentStart = Math.round(Number(segment.start));
    const segmentEnd = Math.round(Number(segment.end));
    if (!Number.isFinite(segmentStart) || !Number.isFinite(segmentEnd)
        || segmentEnd < segmentStart) return 0;

    const items = segment.items.filter((item) => item && typeof item === 'object');
    const minimumDuration = segmentEnd - segmentStart >= items.length ? 1 : 0;
    let previousItemEnd = segmentStart;
    let processed = 0;
    let fixed = 0;
    segment.items.forEach((item) => {
      if (!item || typeof item !== 'object') return;
      const rawStart = Number(item.start);
      const rawEnd = Number(item.end);
      const candidateStart = Number.isFinite(rawStart)
        ? Math.round(rawStart) : previousItemEnd;
      const candidateEnd = Number.isFinite(rawEnd)
        ? Math.round(rawEnd) : candidateStart;
      const remainingItems = items.length - processed - 1;
      const latestEnd = segmentEnd - minimumDuration * remainingItems;
      const latestStart = latestEnd - minimumDuration;
      const itemStart = Math.min(
        Math.max(candidateStart, previousItemEnd, segmentStart),
        latestStart,
      );
      const itemEnd = Math.min(
        Math.max(candidateEnd, itemStart + minimumDuration),
        latestEnd,
      );
      if (item.start !== itemStart || item.end !== itemEnd) fixed += 1;
      item.start = itemStart;
      item.end = itemEnd;
      previousItemEnd = itemEnd;
      processed += 1;
    });
    return fixed;
  }


  function timedItemsFitSegmentRange(segment, start, end) {
    const items = Array.isArray(segment?.items) ? segment.items : null;
    if (!items) return true;
    let previousEnd = start;
    return items.every((item) => {
      const itemStart = Number(item?.start);
      const itemEnd = Number(item?.end);
      const valid = Number.isInteger(itemStart)
        && Number.isInteger(itemEnd)
        && itemStart >= start
        && itemEnd <= end
        && itemStart >= previousEnd
        && itemEnd > itemStart;
      if (valid) previousEnd = itemEnd;
      return valid;
    });
  }


  // 修复一处相邻字幕段的时间重叠。默认把后句起点吸附到前句终点；
  // 也可以显式选择缩短前句。只修改指定的一对字幕，不静默重排后续时间轴。
  // 如果边界移动会让目标段的 items 越界，则删除该段 items，保留字幕段整体时间。
  function repairSegmentOverlap(segments, index, mode = 'shift-current') {
    const source = Array.isArray(segments) ? segments : [];
    const currentIndex = Number(index);
    if (!Number.isInteger(currentIndex) || currentIndex <= 0 || currentIndex >= source.length) {
      return { changed: false, reason: 'invalid-index', overlapMs: 0 };
    }
    const previous = source[currentIndex - 1];
    const current = source[currentIndex];
    if (!previous || typeof previous !== 'object' || !current || typeof current !== 'object') {
      return { changed: false, reason: 'invalid-segment', overlapMs: 0 };
    }
    const previousStart = Math.round(Number(previous.start));
    const previousEnd = Math.round(Number(previous.end));
    const currentStart = Math.round(Number(current.start));
    const currentEnd = Math.round(Number(current.end));
    const overlapMs = Number.isFinite(previousEnd) && Number.isFinite(currentStart)
      ? previousEnd - currentStart : 0;
    if (!Number.isFinite(overlapMs) || overlapMs <= 0) {
      return { changed: false, reason: 'no-overlap', overlapMs: Math.max(0, overlapMs || 0) };
    }

    const trimPrevious = mode === 'trim-previous';
    const target = trimPrevious ? previous : current;
    const nextStart = trimPrevious ? previousStart : previousEnd;
    const nextEnd = trimPrevious ? currentStart : currentEnd;
    if (!Number.isFinite(nextStart) || !Number.isFinite(nextEnd) || nextEnd <= nextStart) {
      return { changed: false, reason: 'no-room', overlapMs };
    }
    const clearsItems = Array.isArray(target.items)
      && target.items.length > 0
      && !timedItemsFitSegmentRange(target, nextStart, nextEnd);
    if (trimPrevious) target.end = nextEnd;
    else target.start = nextStart;
    if (clearsItems) delete target.items;
    target._dirty = true;
    return {
      changed: true,
      mode: trimPrevious ? 'trim-previous' : 'shift-current',
      overlapMs,
      changedIndices: [trimPrevious ? currentIndex - 1 : currentIndex],
      itemsCleared: clearsItems,
    };
  }


  // 拼合字幕计划（纯函数，不改动输入）。返回：
  // - snaps: [{ index, edge, time }]，相邻间隔在 (0, gapMs] 时：
  //   snapDirection 'backward'（向前拓展，默认）把后方字幕 start 前拓到前一条 end；
  //   snapDirection 'forward'（向后拓展）把前方字幕 end 后延到后一条 start。
  // - groups: [[idx, ...]]，过短字幕的合并组；absorbDirection 'previous'（向前吸收，
  //   默认）并入上一条、'next'（向后吸收）并入下一条；absorbShort 为 false 时不合并。
  //   吸收同样要求两条字幕的实际间隔在 [0, gapMs] 内；禁用项或 speaker 不一致的组合不合并。
  function planAutoMerge(segments, options = {}) {
    const gapMs = Math.max(0, Math.round(Number(options.gapMs) || 0));
    const snapDirection = options.snapDirection === 'forward' ? 'forward' : 'backward';
    const absorbShort = options.absorbShort !== false;
    const absorbDirection = options.absorbDirection === 'next' ? 'next' : 'previous';
    const shortCount = Math.max(1, Math.round(Number(options.shortCount) || 3));
    const source = Array.isArray(segments) ? segments : [];
    const snaps = [];
    for (let i = 1; i < source.length; i++) {
      const previous = source[i - 1];
      const current = source[i];
      if (!previous || !current) continue;
      if (!Number.isFinite(previous.end) || !Number.isFinite(current.start)) continue;
      const gap = current.start - previous.end;
      if (gap <= 0 || gap > gapMs) continue;
      if (snapDirection === 'forward') snaps.push({ index: i - 1, edge: 'end', time: current.start });
      else snaps.push({ index: i, edge: 'start', time: previous.end });
    }
    const canMergePair = (leftIdx, rightIdx) => {
      const left = source[leftIdx];
      const right = source[rightIdx];
      if (!left || !right) return false;
      if (left.disabled || right.disabled) return false;
      if (!Number.isFinite(left.end) || !Number.isFinite(right.start)) return false;
      const gap = right.start - left.end;
      if (gap < 0 || gap > gapMs) return false;
      return (left.speaker ?? null) === (right.speaker ?? null);
    };
    const groups = [];
    if (absorbShort) {
      const indexRange = (from, to) => Array.from({ length: to - from + 1 }, (_, k) => from + k);
      let i = 0;
      while (i < source.length) {
        if (!isShortSubtitleText(source[i]?.text, shortCount)) { i++; continue; }
        // 连续过短字幕区间 [i..j]（相邻短字幕之间也要满足合并条件）
        let j = i;
        while (j + 1 < source.length
            && isShortSubtitleText(source[j + 1]?.text, shortCount)
            && canMergePair(j, j + 1)) j++;
        const lastGroup = groups[groups.length - 1];
        const canExtendLast = !!(lastGroup && lastGroup[lastGroup.length - 1] === i - 1 && canMergePair(i - 1, i));
        const canMergeBackward = i > 0 && canMergePair(i - 1, i);
        const canMergeForward = j + 1 < source.length && canMergePair(j, j + 1);
        if (absorbDirection === 'next') {
          // 向后吸收：优先并入下一条；没有下一条（或不可合并）时退回上一条
          if (canMergeForward) groups.push(indexRange(i, j + 1));
          else if (canExtendLast) for (let k = i; k <= j; k++) lastGroup.push(k);
          else if (canMergeBackward) groups.push(indexRange(i - 1, j));
        } else {
          // 向前吸收：优先并入上一条；首条（或上一条不可合并）时退回下一条
          if (canExtendLast) for (let k = i; k <= j; k++) lastGroup.push(k);
          else if (canMergeBackward) groups.push(indexRange(i - 1, j));
          else if (canMergeForward) groups.push(indexRange(i, j + 1));
        }
        i = j + 1;
      }
    }
    return { snaps, groups };
  }


  // 应用拼合间隔计划（原地修改 segments）：向前拓展把后方字幕 start 前拓到前一条
  // end；向后拓展把前方字幕 end 后延到后一条 start。只许延长、不许缩短。
  // 返回实际改动的字幕条数。
  function applyAutoMergeSnaps(segments, snaps) {
    const source = Array.isArray(segments) ? segments : [];
    let changed = 0;
    (Array.isArray(snaps) ? snaps : []).forEach((snap) => {
      const segment = source[snap?.index];
      if (!segment || !Number.isFinite(snap.time)) return;
      if (snap.edge === 'end') {
        if (snap.time > segment.end) {
          segment.end = snap.time;
          segment._dirty = true;
          changed++;
        }
      } else if (snap.time >= 0 && snap.time < segment.start) {
        segment.start = snap.time;
        segment._dirty = true;
        changed++;
      }
    });
    return changed;
  }


  // 延长字幕计划（纯函数，不改动输入）：先把选中字幕的起点向前延长，
  // 再把终点向后延长。两侧都只使用相邻字幕当前的边界和媒体时长作为上限，
  // 因而不会越过其它字幕或媒体末尾；延长时不触碰段内 items 的绝对时间码。
  // 返回每条字幕的实际前/后延长量，供 UI 统计“完整 / 部分 / 未延长”。
  function planSubtitleExtension(segments, indices, options = {}) {
    const source = Array.isArray(segments) ? segments : [];
    const requestedIndices = indices == null
      ? []
      : Array.from(indices || []);
    const targetIndices = (requestedIndices.length ? requestedIndices : source.map((_, index) => index))
      .map((index) => Number(index))
      .filter((index) => Number.isInteger(index) && index >= 0 && index < source.length)
      .filter((index, position, values) => values.indexOf(index) === position)
      .sort((a, b) => a - b);
    const normalizeMs = (value) => {
      const numeric = Number(value);
      return Number.isFinite(numeric) && numeric >= 0 ? Math.round(numeric) : 0;
    };
    const forwardMs = normalizeMs(options.forwardMs);
    const backwardMs = normalizeMs(options.backwardMs);
    const duration = Number(options.durationMs);
    const durationMs = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
    const planned = new Map();

    targetIndices.forEach((index) => {
      const segment = source[index];
      const start = Number(segment?.start);
      const end = Number(segment?.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return;
      planned.set(index, {
        index,
        start,
        end,
        forwardAppliedMs: 0,
        backwardAppliedMs: 0,
      });
    });

    // 向前延长优先：先统一处理所有字幕起点，避免同一次执行的后延改变前拓上限。
    targetIndices.forEach((index) => {
      const change = planned.get(index);
      if (!change || forwardMs <= 0) return;
      const previousEnd = index > 0 ? Number(source[index - 1]?.end) : 0;
      const lowerBound = Number.isFinite(previousEnd) ? Math.max(0, previousEnd) : 0;
      // 已经与前句重叠时不反向缩短当前字幕，只报告为未延长。
      const available = Math.max(0, change.start - lowerBound);
      const applied = Math.min(forwardMs, available);
      if (applied > 0) {
        change.start -= applied;
        change.forwardAppliedMs = applied;
      }
    });

    targetIndices.forEach((index) => {
      const change = planned.get(index);
      if (!change || backwardMs <= 0) return;
      const nextChange = planned.get(index + 1);
      const nextStart = nextChange
        ? nextChange.start
        : index + 1 < source.length
          ? Number(source[index + 1]?.start)
          : durationMs;
      const upperBound = Number.isFinite(nextStart) ? nextStart : durationMs;
      // 已经与后句重叠时不反向缩短当前字幕，只报告为未延长。
      const available = Math.max(0, upperBound - change.end);
      const applied = Math.min(backwardMs, available);
      if (applied > 0) {
        change.end += applied;
        change.backwardAppliedMs = applied;
      }
    });

    const changes = [...planned.values()].filter((change) => (
      change.start !== Number(source[change.index]?.start)
      || change.end !== Number(source[change.index]?.end)
    )).map((change) => {
      const forwardPartial = forwardMs > 0 && change.forwardAppliedMs < forwardMs;
      const backwardPartial = backwardMs > 0 && change.backwardAppliedMs < backwardMs;
      const partial = forwardPartial || backwardPartial;
      return {
        ...change,
        changed: change.forwardAppliedMs > 0 || change.backwardAppliedMs > 0,
        partial,
      };
    });
    const changedIndices = changes.filter((change) => change.changed).map((change) => change.index);
    return {
      indices: targetIndices,
      changes,
      changedIndices,
      fullCount: changes.filter((change) => change.changed && !change.partial).length,
      partialCount: changes.filter((change) => change.changed && change.partial).length,
      unchangedCount: targetIndices.length - changedIndices.length,
      forwardMs,
      backwardMs,
    };
  }


  function applySubtitleExtension(segments, indices, options = {}) {
    const source = Array.isArray(segments) ? segments : [];
    const plan = planSubtitleExtension(source, indices, options);
    plan.changes.forEach((change) => {
      const segment = source[change.index];
      if (!segment || !change.changed) return;
      segment.start = change.start;
      segment.end = change.end;
      segment._dirty = true;
    });
    return plan;
  }


  function formatHumanDuration(durationMs) {
    const totalSeconds = Math.max(0, Math.floor(Number(durationMs) / 1000) || 0);
    const seconds = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    if (totalMinutes < 1) return `${totalSeconds}秒`;
    const minutes = totalMinutes % 60;
    const hours = Math.floor(totalMinutes / 60);
    if (hours < 1) return `${minutes}分${seconds ? `${seconds}秒` : ''}`;
    return `${hours}小时${minutes ? `${minutes}分` : ''}${seconds ? `${seconds}秒` : ''}`;
  }


  function formatGapRemoveDuration(removedMs, mediaDurationMs) {
    const durationLabel = formatHumanDuration(removedMs);
    const mediaDuration = Number(mediaDurationMs);
    if (!Number.isFinite(mediaDuration) || mediaDuration <= 0) return durationLabel;
    const percentage = Math.min(100, Math.max(0, (Number(removedMs) / mediaDuration) * 100));
    const percentageLabel = Number(percentage.toFixed(1)).toString();
    return `${durationLabel}（占比 ${percentageLabel}%）`;
  }

  return Object.freeze({ applyAutoMergeSnaps, applySubtitleExtension, formatGapRemoveDuration, formatHumanDuration, normalizeFrameItemTimingRanges, normalizeItemTimingRanges, normalizeSegmentTimings, planAutoMerge, planSubtitleExtension, repairSegmentOverlap });
});
