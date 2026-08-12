// Pure editor helpers kept separate so replacement behavior can be tested
// without constructing the full browser editor DOM.
(function () {
  'use strict';

  function buildReplacementPreview(segments, indexes, find, replacement, options = {}) {
    if (!find) return { error: null, matchCount: 0, lineCount: 0, rows: [] };
    const flags = `${options.caseSensitive ? '' : 'i'}g`;
    let regex;
    try {
      regex = options.useRegex
        ? new RegExp(find, flags)
        : new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    } catch (error) {
      return { error: error.message || String(error), matchCount: 0, lineCount: 0, rows: [] };
    }

    let matchCount = 0;
    const rows = [];
    const targets = Array.isArray(indexes)
      ? indexes.map((index) => ({ index, segment: segments[index] })).filter((entry) => entry.segment)
      : segments.map((segment, index) => ({ index, segment }));
    targets.forEach(({ index, segment }) => {
      regex.lastIndex = 0;
      const matches = segment.text.match(regex);
      if (!matches) return;
      const after = segment.text.replace(regex, replacement);
      matchCount += matches.length;
      if (after !== segment.text) {
        rows.push({
          index,
          before: segment.text,
          after,
          matchCount: matches.length,
        });
      }
    });
    return {
      error: null,
      matchCount,
      lineCount: rows.length,
      rows,
    };
  }

  function countTextUnits(text) {
    const normalized = String(text || '').replace(/\r\n?/g, '').replace(/\n/g, '');
    let total = 0;
    for (const ch of normalized) total += ch.codePointAt(0) < 256 ? 0.5 : 1;
    return total;
  }

  function cueMetrics(text, start, end) {
    const totalLength = countTextUnits(text);
    const durationSeconds = Math.max(0, Number(end) - Number(start)) / 1000;
    const charsPerSecond = durationSeconds > 0
      ? Number((totalLength / durationSeconds).toFixed(2)) : 0;
    return { totalLength, charsPerSecond };
  }

  function joinSegmentTexts(segments, separator) {
    return segments.map((segment) => String(segment?.text || '')).join(separator);
  }

  // 字幕“字数/词数”计量：含 CJK 字符时按「字」计（只数字母与汉字等文字、数字，
  // 不计空白与标点），否则按空白切分计「词」数（同样要求词内至少一个文字/数字）。
  function subtitleTextLength(text) {
    const normalized = String(text || '').trim();
    if (!normalized) return 0;
    // CJK 判定区间：U+3400–U+4DBF（扩展 A）、U+4E00–U+9FFF（基本区）、U+F900–U+FAFF（兼容表意）。
    if (/[㐀-䶿一-鿿豈-﫿]/.test(normalized)) {
      const matches = normalized.match(/[\p{L}\p{N}]/gu);
      return matches ? matches.length : 0;
    }
    return normalized.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
  }

  // 短字幕判定：中文少于 threshold 个字 / 英文少于 threshold 个词。
  function isShortSubtitleText(text, threshold) {
    const limit = Math.max(1, Math.round(Number(threshold) || 3));
    return subtitleTextLength(text) < limit;
  }

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

  // 拼合字幕计划（纯函数，不改动输入）。返回：
  // - snaps: [{ index, edge, time }]，相邻间隔在 (0, gapMs] 时：
  //   snapDirection 'backward'（向前拓展，默认）把后方字幕 start 前拓到前一条 end；
  //   snapDirection 'forward'（向后拓展）把前方字幕 end 后延到后一条 start。
  // - groups: [[idx, ...]]，过短字幕的合并组；absorbDirection 'previous'（向前吸收，
  //   默认）并入上一条、'next'（向后吸收）并入下一条；absorbShort 为 false 时不合并。
  //   吸收同样要求两条字幕的实际间隔在 (0, gapMs] 内；禁用项或 speaker 不一致的组合不合并。
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
      if (gap <= 0 || gap > gapMs) return false;
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

  function timestampedSplitCandidates(segment) {
    const text = String(segment?.text || '');
    const codePoints = Array.from(text);
    if (codePoints.length < 2) return [];
    const hasContent = (value) => /[\p{L}\p{N}\p{S}]/u.test(value);

    const alignedItems = [];
    let searchFrom = 0;
    (Array.isArray(segment?.items) ? segment.items : []).forEach((item) => {
      const itemText = String(item?.text || '');
      if (!itemText) return;
      const start = text.indexOf(itemText, searchFrom);
      if (start < 0) return;
      alignedItems.push({ item, start, end: start + itemText.length });
      searchFrom = start + itemText.length;
    });

    const candidates = [];
    for (let index = 1; index < alignedItems.length; index++) {
      const left = alignedItems[index - 1];
      const right = alignedItems[index];
      const offset = right.start;
      if (offset <= 0 || offset >= text.length) continue;
      if (!hasContent(text.slice(0, offset)) || !hasContent(text.slice(offset))) continue;
      const leftEnd = Number(left.item.end);
      const rightStart = Number(right.item.start);
      const hasTimestamp = Number.isFinite(leftEnd) && Number.isFinite(rightStart);
      let boundaryTime = Number.isFinite(leftEnd) && Number.isFinite(rightStart)
        ? (leftEnd + rightStart) / 2
        : Number.isFinite(rightStart) ? rightStart : leftEnd;
      if (!Number.isFinite(boundaryTime)) {
        boundaryTime = Number(segment?.start)
          + ((Number(segment?.end) - Number(segment?.start)) * offset / text.length);
      }
      candidates.push({ offset, time: boundaryTime, hasTimestamp });
    }
    return candidates;
  }

  function hasUsableSplitTimestamps(segment) {
    return timestampedSplitCandidates(segment).some((candidate) => candidate.hasTimestamp);
  }

  function splitCharOffsetAtTime(segment, timeMs) {
    const text = String(segment?.text || '');
    const codePoints = Array.from(text);
    if (codePoints.length < 2) return null;
    const hasContent = (value) => /[\p{L}\p{N}\p{S}]/u.test(value);
    const targetTime = Number(timeMs);
    const candidates = timestampedSplitCandidates(segment);
    if (candidates.length && Number.isFinite(targetTime)) {
      return candidates.reduce((nearest, candidate) => (
        Math.abs(candidate.time - targetTime) < Math.abs(nearest.time - targetTime)
          ? candidate : nearest
      )).offset;
    }

    const offsets = [];
    let utf16Offset = 0;
    codePoints.forEach((character, index) => {
      utf16Offset += character.length;
      if (index < codePoints.length - 1
          && hasContent(text.slice(0, utf16Offset))
          && hasContent(text.slice(utf16Offset))) {
        offsets.push(utf16Offset);
      }
    });
    if (!offsets.length) return null;
    const start = Number(segment?.start);
    const end = Number(segment?.end);
    const ratio = Number.isFinite(targetTime) && Number.isFinite(start) && Number.isFinite(end) && end > start
      ? Math.max(0, Math.min(1, (targetTime - start) / (end - start)))
      : 0.5;
    const index = Math.max(0, Math.min(offsets.length - 1, Math.round(ratio * codePoints.length) - 1));
    return offsets[index] ?? null;
  }

  function findAdjacentCueIndex(segments, currentIndex, direction, skipDisabled = false) {
    for (let index = currentIndex + direction; index >= 0 && index < segments.length; index += direction) {
      if (!skipDisabled || !segments[index]?.disabled) return index;
    }
    return -1;
  }

  function findCueNavigationTarget(segments, currentIndex, timeMs, direction, skipDisabled = false) {
    if (!Array.isArray(segments) || !segments.length || (direction !== -1 && direction !== 1)) return -1;
    if (Number.isInteger(currentIndex) && currentIndex >= 0 && currentIndex < segments.length) {
      return findAdjacentCueIndex(segments, currentIndex, direction, skipDisabled);
    }

    const time = Number(timeMs);
    if (!Number.isFinite(time)) return -1;
    const activeIndex = segments.findIndex((segment) => (
      segment && Number(segment.start) <= time && Number(segment.end) >= time
    ));
    if (activeIndex >= 0) {
      return findAdjacentCueIndex(segments, activeIndex, direction, skipDisabled);
    }

    if (direction < 0) {
      for (let index = segments.length - 1; index >= 0; index -= 1) {
        if (Number(segments[index]?.start) >= time) continue;
        if (!skipDisabled || !segments[index]?.disabled) return index;
      }
      return -1;
    }
    for (let index = 0; index < segments.length; index += 1) {
      if (Number(segments[index]?.start) <= time) continue;
      if (!skipDisabled || !segments[index]?.disabled) return index;
    }
    return -1;
  }

  function findCueSelectionExtensionTarget(
    segments,
    selectedIndexes,
    currentIndex,
    timeMs,
    direction,
    skipDisabled = false,
  ) {
    if (!Array.isArray(segments) || !segments.length || (direction !== -1 && direction !== 1)) return -1;
    const selected = Array.from(selectedIndexes || [])
      .filter((index) => Number.isInteger(index) && index >= 0 && index < segments.length);
    if (!selected.length) {
      return findCueNavigationTarget(
        segments,
        currentIndex,
        timeMs,
        direction,
        skipDisabled,
      );
    }
    const edge = direction < 0 ? Math.min(...selected) : Math.max(...selected);
    return findAdjacentCueIndex(segments, edge, direction, skipDisabled);
  }

  function cloneJsonValue(value) {
    return value == null ? null : JSON.parse(JSON.stringify(value));
  }

  // === 多重字幕（双语字幕）===
  // 这组 helper 刻意不依赖 DOM，便携 HTML、localhost 编辑器和 Node 测试共用同一套
  // 数据/匹配/近似拆分规则。主轨仍然是顶层 segments；扩展轨的 items 不参与拆分。
  const MULTI_SUBTITLE_SCHEMA = 'moy.asr.multi_subtitle.v1';
  const MULTI_SUBTITLE_TOLERANCE_MS = 300;
  const MULTI_SUBTITLE_DISPLAY_MODES = new Set(['main', 'extension', 'both']);
  const MULTI_SUBTITLE_SPLIT_MODES = new Set(['continuous', 'word']);

  function stableId(value) {
    const id = String(value == null ? '' : value).trim();
    return id && id.length <= 160 ? id : '';
  }

  function ensureStableSegmentIds(segments, prefix = 'segment') {
    const source = Array.isArray(segments) ? segments : [];
    const used = new Set();
    let changed = 0;
    source.forEach((segment, index) => {
      if (!segment || typeof segment !== 'object') return;
      let id = stableId(segment.id);
      if (!id || used.has(id)) {
        const base = `${prefix}-${String(index + 1).padStart(3, '0')}`;
        id = base;
        let suffix = 2;
        while (used.has(id)) id = `${base}-${suffix++}`;
        segment.id = id;
        changed++;
      } else if (segment.id !== id) {
        segment.id = id;
        changed++;
      }
      used.add(id);
    });
    return changed;
  }

  function uniqueStableSegmentId(segments, baseId, fallbackPrefix = 'segment') {
    const used = new Set((Array.isArray(segments) ? segments : [])
      .map((segment) => stableId(segment?.id)).filter(Boolean));
    const base = stableId(baseId) || `${fallbackPrefix}-new`;
    if (!used.has(base)) return base;
    let suffix = 2;
    let candidate = `${base}-${suffix}`;
    while (used.has(candidate)) candidate = `${base}-${suffix++}`;
    return candidate;
  }

  function normalizeMultiSubtitle(value, mainSegments = []) {
    const source = value && typeof value === 'object' ? value : {};
    const rawTracks = Array.isArray(source.tracks) ? source.tracks : [];
    const tracks = rawTracks.map((rawTrack, trackIndex) => {
      const track = rawTrack && typeof rawTrack === 'object' ? rawTrack : {};
      const id = stableId(track.id) || `extension-${trackIndex + 1}`;
      const rawSegments = Array.isArray(track.segments) ? track.segments : [];
      const segments = rawSegments
        .filter((segment) => segment && typeof segment === 'object')
        .map((segment) => {
          const copy = { ...segment };
          // Extension SRT has no reliable word timestamps. Do not accidentally
          // treat an imported mosp item's timestamps as audio-aligned data.
          delete copy.items;
          return copy;
        });
      ensureStableSegmentIds(segments, `${id}-segment`);
      return {
        id,
        role: 'extension',
        name: typeof track.name === 'string' && track.name.trim() ? track.name : '扩展字幕',
        language: typeof track.language === 'string' ? track.language : '',
        source_name: typeof track.source_name === 'string' ? track.source_name : '',
        split_mode: MULTI_SUBTITLE_SPLIT_MODES.has(track.split_mode)
          ? track.split_mode : detectSubtitleSplitMode(segments.map((s) => s.text).join('\n'), track.language),
        segments,
      };
    });
    const mainIds = new Set((Array.isArray(mainSegments) ? mainSegments : [])
      .map((segment) => stableId(segment?.id)).filter(Boolean));
    const extensionIds = new Map(tracks.map((track) => [track.id, new Set(track.segments.map((s) => s.id))]));
    const bindings = Array.isArray(source.bindings) ? source.bindings : [];
    const normalizedBindings = bindings.map((rawBinding, index) => {
      const binding = rawBinding && typeof rawBinding === 'object' ? rawBinding : {};
      const trackId = stableId(binding.track_id) || tracks[0]?.id || 'extension-1';
      const trackIds = extensionIds.get(trackId) || new Set();
      const mainSegmentIds = (Array.isArray(binding.main_segment_ids)
        ? binding.main_segment_ids : binding.main_segment_id ? [binding.main_segment_id] : [])
        .map(stableId).filter((id) => mainIds.has(id));
      const extensionSegmentIds = (Array.isArray(binding.extension_segment_ids)
        ? binding.extension_segment_ids : binding.extension_segment_id ? [binding.extension_segment_id] : [])
        .map(stableId).filter((id) => trackIds.has(id));
      if (!mainSegmentIds.length || !extensionSegmentIds.length) return null;
      return {
        id: stableId(binding.id) || `binding-${String(index + 1).padStart(3, '0')}`,
        track_id: trackId,
        main_segment_ids: [...new Set(mainSegmentIds)],
        extension_segment_ids: [...new Set(extensionSegmentIds)],
        start_offset_ms: Number.isFinite(Number(binding.start_offset_ms))
          ? Math.round(Number(binding.start_offset_ms)) : 0,
        end_offset_ms: Number.isFinite(Number(binding.end_offset_ms))
          ? Math.round(Number(binding.end_offset_ms)) : 0,
      };
    }).filter(Boolean);
    const dedupedBindings = [];
    const seenMain = new Set();
    const seenExtension = new Set();
    normalizedBindings.forEach((binding) => {
      // MVP editing is one-to-one. Keep the first valid relation when a malformed
      // imported project contains duplicate endpoints, while retaining arrays for
      // a future one-to-many binding model.
      const mainKey = binding.main_segment_ids.join('|');
      const extensionKey = `${binding.track_id}:${binding.extension_segment_ids.join('|')}`;
      if (seenMain.has(mainKey) || seenExtension.has(extensionKey)) return;
      seenMain.add(mainKey);
      seenExtension.add(extensionKey);
      dedupedBindings.push(binding);
    });
    const normalized = {
      schema: MULTI_SUBTITLE_SCHEMA,
      enabled: source.enabled === true,
      display_mode: MULTI_SUBTITLE_DISPLAY_MODES.has(source.display_mode)
        ? source.display_mode : 'both',
      tracks,
      bindings: dedupedBindings,
    };
    rebuildBindingOffsets(normalized, mainSegments);
    return normalized;
  }

  function normalizeMultiSubtitleProject(project) {
    if (!project || typeof project !== 'object') return project;
    ensureStableSegmentIds(project.segments, 'main');
    project.multi_subtitle = normalizeMultiSubtitle(project.multi_subtitle, project.segments);
    return project;
  }

  function detectSubtitleSplitMode(text, language = '') {
    const value = `${String(language || '')} ${String(text || '')}`;
    return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u.test(value)
      ? 'continuous' : 'word';
  }

  function subtitleSplitOffsets(text, mode = 'word') {
    const value = String(text || '');
    const offsets = [];
    const isBoundaryPunctuation = (character) => /[，。！？；：、“”‘’（）()\[\]{}.,!?;:'"\-—]/u.test(character);
    let offset = 0;
    const characters = Array.from(value);
    for (let index = 0; index < characters.length - 1; index++) {
      offset += characters[index].length;
      const previous = characters[index];
      const next = characters[index + 1];
      const legal = mode === 'continuous'
        || /\s/u.test(previous) || /\s/u.test(next)
        || isBoundaryPunctuation(previous) || isBoundaryPunctuation(next);
      if (legal && offset > 0 && offset < value.length) offsets.push(offset);
    }
    return [...new Set(offsets)];
  }

  function cleanSplitTextParts(text, offset) {
    const value = String(text || '');
    const safeOffset = Math.max(0, Math.min(value.length, Math.round(Number(offset) || 0)));
    const left = value.slice(0, safeOffset).replace(/[，。,.!?！？；;：:\s]+$/u, '');
    const right = value.slice(safeOffset).replace(/^[，。,.!?！？；;：:\s]+/u, '');
    return { left, right, offset: safeOffset };
  }

  function splitSubtitleText(text, offset, mode = 'word') {
    const parts = cleanSplitTextParts(text, offset);
    if (!parts.left || !parts.right) return null;
    const offsets = subtitleSplitOffsets(text, mode);
    if (!offsets.includes(parts.offset)) return null;
    return parts;
  }

  function nearestSubtitleSplitOffset(text, timeMs, segmentStart, segmentEnd, mode = 'word') {
    const offsets = subtitleSplitOffsets(text, mode);
    if (!offsets.length) return null;
    const start = Number(segmentStart);
    const end = Number(segmentEnd);
    const target = Number(timeMs);
    const ratio = Number.isFinite(target) && Number.isFinite(start) && Number.isFinite(end) && end > start
      ? Math.max(0, Math.min(1, (target - start) / (end - start))) : 0.5;
    const desired = ratio * String(text || '').length;
    return offsets.reduce((best, offset) => Math.abs(offset - desired) < Math.abs(best - desired) ? offset : best, offsets[0]);
  }

  function bindingForSegment(multiSubtitle, segmentId, side = 'either', trackId = null) {
    const id = stableId(segmentId);
    if (!id || !multiSubtitle) return null;
    return (Array.isArray(multiSubtitle.bindings) ? multiSubtitle.bindings : []).find((binding) => {
      if (trackId && binding.track_id !== trackId) return false;
      const inMain = binding.main_segment_ids?.includes(id);
      const inExtension = binding.extension_segment_ids?.includes(id);
      return side === 'main' ? inMain : side === 'extension' ? inExtension : inMain || inExtension;
    }) || null;
  }

  function buildSubtitleBinding(mainSegment, extensionSegment, trackId, id = null) {
    const main = mainSegment || {};
    const extension = extensionSegment || {};
    return {
      id: stableId(id) || `binding-${stableId(main.id) || 'main'}-${stableId(extension.id) || 'extension'}`,
      track_id: stableId(trackId) || 'extension-1',
      main_segment_ids: stableId(main.id) ? [main.id] : [],
      extension_segment_ids: stableId(extension.id) ? [extension.id] : [],
      start_offset_ms: Math.round(Number(extension.start) - Number(main.start)) || 0,
      end_offset_ms: Math.round(Number(extension.end) - Number(main.end)) || 0,
    };
  }

  function rebuildBindingOffsets(multiSubtitle, mainSegments) {
    if (!multiSubtitle) return multiSubtitle;
    const mainById = new Map((Array.isArray(mainSegments) ? mainSegments : [])
      .map((segment) => [stableId(segment?.id), segment]));
    const trackById = new Map((multiSubtitle.tracks || []).map((track) => [track.id, track]));
    (multiSubtitle.bindings || []).forEach((binding) => {
      const main = mainById.get(binding.main_segment_ids?.[0]);
      const track = trackById.get(binding.track_id);
      const extension = track?.segments?.find((segment) => segment.id === binding.extension_segment_ids?.[0]);
      if (!main || !extension) return;
      binding.start_offset_ms = Math.round(Number(extension.start) - Number(main.start));
      binding.end_offset_ms = Math.round(Number(extension.end) - Number(main.end));
    });
    return multiSubtitle;
  }

  // 交换主轨与当前唯一扩展轨。MVP 的扩展轨只保存文本/时间/稳定 ID，
  // 因此从主轨降级到扩展轨时不携带 items、表情包和颜色分组等主轨专属字段。
  // 绑定关系按端点整体交换，并在新主轨写入后重新计算 offset。
  function swapMainAndExtensionSubtitle(project, trackId = null) {
    if (!project || typeof project !== 'object' || !Array.isArray(project.segments)) {
      return { swapped: false, reason: 'invalid-project' };
    }
    ensureStableSegmentIds(project.segments, 'main');
    const multi = normalizeMultiSubtitle(project.multi_subtitle, project.segments);
    project.multi_subtitle = multi;
    const tracks = Array.isArray(multi.tracks) ? multi.tracks : [];
    if (tracks.length !== 1) return { swapped: false, reason: 'unsupported-track-count' };
    const track = tracks.find((candidate) => !trackId || candidate.id === trackId);
    if (!track || !Array.isArray(track.segments)) return { swapped: false, reason: 'missing-track' };
    if (!project.segments.length || !track.segments.length) return { swapped: false, reason: 'empty-track' };

    const oldMain = cloneJsonValue(project.segments) || [];
    const oldExtension = cloneJsonValue(track.segments) || [];
    const nextMain = oldExtension.map((segment) => ({ ...segment }));
    const nextExtension = oldMain.map((segment) => {
      const copy = {
        id: stableId(segment.id),
        start: segment.start,
        end: segment.end,
        text: typeof segment.text === 'string' ? segment.text : '',
      };
      if (segment._dirty) copy._dirty = true;
      return copy;
    });

    project.segments.length = 0;
    nextMain.forEach((segment) => project.segments.push(segment));
    track.segments = nextExtension;

    let bindingCount = 0;
    (multi.bindings || []).forEach((binding) => {
      if (binding.track_id !== track.id) return;
      const mainIds = binding.main_segment_ids;
      binding.main_segment_ids = [...(binding.extension_segment_ids || [])];
      binding.extension_segment_ids = [...(mainIds || [])];
      bindingCount++;
    });
    rebuildBindingOffsets(multi, project.segments);
    return {
      swapped: true,
      trackId: track.id,
      mainCount: project.segments.length,
      extensionCount: track.segments.length,
      bindingCount,
    };
  }

  function removeSubtitleBindings(multiSubtitle, predicate) {
    if (!multiSubtitle || !Array.isArray(multiSubtitle.bindings)) return [];
    const removed = [];
    multiSubtitle.bindings = multiSubtitle.bindings.filter((binding) => {
      if (!predicate(binding)) return true;
      removed.push(binding);
      return false;
    });
    return removed;
  }

  function matchSubtitleSegments(mainSegments, extensionSegments, toleranceMs = MULTI_SUBTITLE_TOLERANCE_MS) {
    const main = Array.isArray(mainSegments) ? mainSegments : [];
    const extension = Array.isArray(extensionSegments) ? extensionSegments : [];
    const tolerance = Math.max(0, Math.round(Number(toleranceMs) || MULTI_SUBTITLE_TOLERANCE_MS));
    const candidates = [];
    const byExtension = extension.map(() => []);
    const byMain = main.map(() => []);
    extension.forEach((candidateExtension, extensionIndex) => {
      main.forEach((candidateMain, mainIndex) => {
        const startDiff = Math.abs(Number(candidateExtension?.start) - Number(candidateMain?.start));
        const endDiff = Math.abs(Number(candidateExtension?.end) - Number(candidateMain?.end));
        const overlaps = Number(candidateExtension?.start) <= Number(candidateMain?.end)
          && Number(candidateExtension?.end) >= Number(candidateMain?.start);
        if (!overlaps || startDiff > tolerance || endDiff > tolerance) return;
        const candidate = { mainIndex, extensionIndex, startDiff, endDiff, cost: startDiff + endDiff };
        candidates.push(candidate);
        byExtension[extensionIndex].push(candidate);
        byMain[mainIndex].push(candidate);
      });
    });
    candidates.sort((left, right) => left.cost - right.cost || left.startDiff - right.startDiff
      || left.extensionIndex - right.extensionIndex || left.mainIndex - right.mainIndex);
    const usedMain = new Set();
    const usedExtension = new Set();
    const matches = [];
    candidates.forEach((candidate) => {
      if (usedMain.has(candidate.mainIndex) || usedExtension.has(candidate.extensionIndex)) return;
      usedMain.add(candidate.mainIndex);
      usedExtension.add(candidate.extensionIndex);
      matches.push(candidate);
    });
    const conflictExtensions = byExtension.filter((items) => items.length > 1).length;
    const conflictMains = byMain.filter((items) => items.length > 1).length;
    return {
      matches,
      unmatchedMain: main.map((_, index) => index).filter((index) => !usedMain.has(index)),
      unmatchedExtension: extension.map((_, index) => index).filter((index) => !usedExtension.has(index)),
      candidates,
      conflicts: Math.max(conflictExtensions, conflictMains),
      tolerance_ms: tolerance,
    };
  }

  function buildMultiDisplayRows(mainSegments, extensionSegments, bindings = []) {
    const main = Array.isArray(mainSegments) ? mainSegments : [];
    const extension = Array.isArray(extensionSegments) ? extensionSegments : [];
    const extensionById = new Map(extension.map((segment, index) => [stableId(segment?.id), index]));
    const mainToExtension = new Map();
    const extensionBound = new Set();
    bindings.forEach((binding) => {
      const mainId = binding.main_segment_ids?.[0];
      const extensionId = binding.extension_segment_ids?.[0];
      const extensionIndex = extensionById.get(extensionId);
      if (!Number.isInteger(extensionIndex) || mainToExtension.has(mainId)) return;
      mainToExtension.set(mainId, extensionIndex);
      extensionBound.add(extensionIndex);
    });
    const rows = [];
    let extensionCursor = 0;
    main.forEach((segment, mainIndex) => {
      while (extensionCursor < extension.length && !extensionBound.has(extensionCursor)
          && Number(extension[extensionCursor]?.start) <= Number(segment?.start)) {
        rows.push({ mainIndex: null, extensionIndex: extensionCursor++ });
      }
      rows.push({ mainIndex, extensionIndex: mainToExtension.get(segment.id) ?? null });
    });
    while (extensionCursor < extension.length) {
      if (!extensionBound.has(extensionCursor)) rows.push({ mainIndex: null, extensionIndex: extensionCursor });
      extensionCursor++;
    }
    return rows;
  }

  // 合并选区只有在每条字幕都指向同一个有效 group head 时才继承该 group。
  // 若选区包含 head，新字幕继续作为 head；若选区只是同组 refs，则继续指向原 head。
  function resolveMergedGroupInheritance(segments, indexes, headField, refField) {
    if (!Array.isArray(segments) || !Array.isArray(indexes) || !indexes.length) {
      return { head: null, ref: null, headIdx: null };
    }
    const headIndexes = indexes.map((index) => {
      const segment = segments[index];
      if (!segment) return null;
      if (segment[headField]) return index;
      const headIdx = segment[refField]?.headIdx;
      return Number.isInteger(headIdx) && segments[headIdx]?.[headField] ? headIdx : null;
    });
    const commonHeadIdx = headIndexes[0];
    if (
      !Number.isInteger(commonHeadIdx)
      || headIndexes.some((headIdx) => headIdx !== commonHeadIdx)
    ) {
      return { head: null, ref: null, headIdx: null };
    }

    const head = segments[commonHeadIdx][headField];
    if (indexes.includes(commonHeadIdx)) {
      return {
        head: cloneJsonValue(head),
        ref: null,
        headIdx: commonHeadIdx,
      };
    }

    const sourceRef = indexes
      .map((index) => segments[index]?.[refField])
      .find((ref) => ref && ref.headIdx === commonHeadIdx);
    const inheritedRef = cloneJsonValue(sourceRef) || {};
    inheritedRef.headIdx = commonHeadIdx;
    if (!inheritedRef.name && head?.name) inheritedRef.name = head.name;
    return {
      head: null,
      ref: inheritedRef,
      headIdx: commonHeadIdx,
    };
  }

  function getSrtExportFirstIndex(segments, alignFirstEnabled = false) {
    if (!alignFirstEnabled || !Array.isArray(segments)) return -1;
    return segments.findIndex((segment) => (
      segment && !segment.disabled && Number.isFinite(Number(segment.start))
    ));
  }

  // 保留这个数值 helper 供已有调用方使用；SRT 导出本身不应把它从所有时间码中扣除。
  function getSrtExportOffset(segments, alignFirstEnabled = false) {
    const firstIndex = getSrtExportFirstIndex(segments, alignFirstEnabled);
    if (firstIndex < 0) return 0;
    return Math.max(0, Math.round(Number(segments[firstIndex].start)));
  }

  function effectiveColorName(segment, segments) {
    const direct = segment?.color?.name;
    if (typeof direct === 'string' && direct) return direct;
    const reference = segment?.color_ref;
    const headName = Number.isInteger(reference?.headIdx)
      ? segments?.[reference.headIdx]?.color?.name
      : null;
    if (typeof headName === 'string' && headName) return headName;
    return typeof reference?.name === 'string' && reference.name ? reference.name : null;
  }

  // 在字幕数组中插入新段后，所有指向插入点及其后方 head 的引用都右移。
  // headIdx 是数组下标，不随 Array.splice 自动更新；调用方必须在插入后立即调用。
  function shiftGroupReferenceIndices(segments, insertionIndex, delta = 1) {
    if (!Array.isArray(segments)) return 0;
    const pivot = Number(insertionIndex);
    const shift = Number(delta);
    if (!Number.isInteger(pivot) || !Number.isInteger(shift) || shift === 0) return 0;
    let changed = 0;
    segments.forEach((segment) => {
      ['sticker_ref', 'color_ref'].forEach((field) => {
        const reference = segment?.[field];
        if (!reference || !Number.isInteger(reference.headIdx) || reference.headIdx < pivot) return;
        reference.headIdx += shift;
        changed++;
      });
    });
    return changed;
  }

  // 兼容旧工程中因插入字幕导致的错位引用：引用自身保留了 head 的名称，
  // 可用它在当前条目之前寻找最近的同名 head。合法引用不做任何改动。
  function repairGroupReferenceIndices(segments) {
    if (!Array.isArray(segments)) return 0;
    const groups = [
      { head: 'sticker', reference: 'sticker_ref' },
      { head: 'color', reference: 'color_ref' },
    ];
    let repaired = 0;
    segments.forEach((segment, index) => {
      groups.forEach(({ head, reference }) => {
        const ref = segment?.[reference];
        if (!ref || !Number.isInteger(ref.headIdx)) return;
        const currentHead = segments[ref.headIdx]?.[head];
        if (currentHead && (!ref.name || currentHead.name === ref.name)) return;
        if (typeof ref.name !== 'string' || !ref.name) return;
        for (let candidate = index - 1; candidate >= 0; candidate--) {
          if (segments[candidate]?.[head]?.name !== ref.name) continue;
          if (ref.headIdx !== candidate) {
            ref.headIdx = candidate;
            repaired++;
          }
          break;
        }
      });
    });
    return repaired;
  }

  function buildSrtPayload(segments, options = {}) {
    const source = Array.isArray(segments) ? segments : [];
    const colorName = typeof options.colorName === 'string' ? options.colorName : null;
    const timeOffset = Math.max(0, Math.round(Number(options.timeOffset)) || 0);
    const mapTime = typeof options.mapTime === 'function'
      ? options.mapTime
      : (timeMs) => Math.max(0, Math.round(Number(timeMs) || 0) - timeOffset);
    const formatTime = typeof options.formatTime === 'function'
      ? options.formatTime
      : (timeMs) => String(timeMs);
    const alignFirstStart = options.alignFirstStart === true;
    const firstEnabledIndex = Number.isInteger(options.firstEnabledIndex)
      ? options.firstEnabledIndex
      : getSrtExportFirstIndex(source, alignFirstStart);
    const parts = [];
    source
      .map((segment, sourceIndex) => ({ segment, sourceIndex }))
      .filter(({ segment }) => {
        if (!segment || segment.disabled) return false;
        if (!colorName) return true;
        const effectiveName = effectiveColorName(segment, source);
        return colorName === 'default' ? !effectiveName : effectiveName === colorName;
      })
      .forEach(({ segment, sourceIndex }, index) => {
        const mappedStart = Math.max(0, Math.round(Number(mapTime(segment.start)) || 0));
        const start = alignFirstStart && sourceIndex === firstEnabledIndex ? 0 : mappedStart;
        const mappedEnd = Math.max(0, Math.round(Number(mapTime(segment.end)) || 0));
        const end = options.ensurePositiveDuration ? Math.max(start + 1, mappedEnd) : mappedEnd;
        parts.push(String(index + 1));
        parts.push(`${formatTime(start)} --> ${formatTime(end)}`);
        parts.push(String(segment.text || ''));
        parts.push('');
      });
    return parts.join('\n');
  }

  function buildPlainTextPayload(segments) {
    return (Array.isArray(segments) ? segments : [])
      .filter((segment) => segment && !segment.disabled)
      .map((segment) => String(segment.text || '').replace(/\r\n?/g, '\n'))
      .join('\n');
  }

  function fileBasename(value) {
    return String(value || '').trim().split(/[\\/]/).pop() || '';
  }

  function gapKey(gap) {
    return `${Math.round(Number(gap.start))}:${Math.round(Number(gap.end))}`;
  }

  function normalizeGapRemoveGaps(gaps) {
    if (!Array.isArray(gaps)) return [];
    const seen = new Set();
    return gaps
      .map((gap) => ({
        start: Math.max(0, Math.round(Number(gap?.start))),
        end: Math.max(0, Math.round(Number(gap?.end))),
        removed: gap?.removed !== false,
      }))
      .filter((gap) => Number.isFinite(gap.start) && Number.isFinite(gap.end) && gap.end > gap.start)
      .sort((left, right) => left.start - right.start || left.end - right.end)
      .filter((gap) => {
        const key = gapKey(gap);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  function coalesceGapRemoveGaps(gaps) {
    const result = [];
    normalizeGapRemoveGaps(gaps).forEach((gap) => {
      const previous = result[result.length - 1];
      if (!previous) {
        result.push({ ...gap });
        return;
      }
      if (gap.start <= previous.end && gap.removed === previous.removed) {
        previous.end = Math.max(previous.end, gap.end);
        return;
      }
      const start = Math.max(gap.start, previous.end);
      if (gap.end > start) result.push({ ...gap, start });
    });
    return result;
  }

  function applyGapRemoveRange(gaps, startMs, endMs, removed) {
    const source = coalesceGapRemoveGaps(gaps);
    const start = Math.max(0, Math.round(Math.min(Number(startMs), Number(endMs))));
    const end = Math.max(0, Math.round(Math.max(Number(startMs), Number(endMs))));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return source;

    const next = [];
    source.forEach((gap) => {
      if (gap.end <= start || gap.start >= end) {
        next.push({ ...gap });
        return;
      }
      if (gap.start < start) next.push({ ...gap, end: start });
      if (!removed) {
        next.push({
          start: Math.max(gap.start, start),
          end: Math.min(gap.end, end),
          removed: false,
        });
      }
      if (gap.end > end) next.push({ ...gap, start: end });
    });
    if (removed) next.push({ start, end, removed: true });
    return coalesceGapRemoveGaps(next);
  }

  function resizeGapRemoveBoundary(gaps, index, edge, valueMs, minimumMs = 10) {
    const source = coalesceGapRemoveGaps(gaps);
    let gapIndex = Math.round(Number(index));
    const value = Math.round(Number(valueMs));
    const minimum = Math.max(1, Math.round(Number(minimumMs) || 10));
    if (!Number.isFinite(gapIndex) || !Number.isFinite(value)
        || gapIndex < 0 || gapIndex >= source.length || !['start', 'end'].includes(edge)) {
      return source;
    }
    const next = source.map((gap) => ({ ...gap }));
    const gap = next[gapIndex];
    if (edge === 'start') {
      const previous = next[gapIndex - 1];
      const shared = previous && previous.end === gap.start;
      if (shared) {
        const boundary = Math.min(
          gap.end - minimum,
          Math.max(previous.start + minimum, value),
        );
        previous.end = boundary;
        gap.start = boundary;
      } else {
        gap.start = Math.min(gap.end - minimum, Math.max(0, value));
        while (gapIndex > 0 && next[gapIndex - 1].end > gap.start) {
          gap.start = Math.min(gap.start, next[gapIndex - 1].start);
          next.splice(gapIndex - 1, 1);
          gapIndex--;
        }
      }
    } else {
      const following = next[gapIndex + 1];
      const shared = following && following.start === gap.end;
      if (shared) {
        const boundary = Math.min(
          following.end - minimum,
          Math.max(gap.start + minimum, value),
        );
        gap.end = boundary;
        following.start = boundary;
      } else {
        gap.end = Math.max(gap.start + minimum, value);
        while (gapIndex + 1 < next.length && next[gapIndex + 1].start < gap.end) {
          gap.end = Math.max(gap.end, next[gapIndex + 1].end);
          next.splice(gapIndex + 1, 1);
        }
      }
    }
    return coalesceGapRemoveGaps(next);
  }

  function waveformPeakDb(peaks, index) {
    const low = Number(peaks[index * 2]);
    const high = Number(peaks[index * 2 + 1]);
    const magnitude = Math.min(127, Math.max(Math.abs(low), Math.abs(high)));
    return magnitude > 0 ? 20 * Math.log10(magnitude / 127) : -Infinity;
  }

  function detectAudioGapRemoveGaps(waveform, options = {}) {
    const peaks = waveform?.peaks;
    const peaksPerSecond = Number(waveform?.peaks_per_second);
    const durationMs = Math.max(0, Math.round(Number(waveform?.duration_ms) || 0));
    if (!peaks || !Number.isFinite(peaksPerSecond) || peaksPerSecond <= 0 || !durationMs) return [];

    const minimumMs = Math.max(0, Math.round(Number(options.minimumMs) || 0));
    const thresholdDb = Math.min(0, Math.max(-96, Number(options.thresholdDb)));
    const openThresholdDb = Number.isFinite(thresholdDb) ? thresholdDb : -24;
    const hysteresisDb = Math.min(30, Math.max(0, Number(options.hysteresisDb) || 0));
    const closeThresholdDb = openThresholdDb - hysteresisDb;
    // 前/后端预留：在每段空隙两侧各保留若干毫秒静音不纳入移除，避免剪掉空隙后两句贴得太急。
    const leadInMs = Math.max(0, Math.round(Number(options.leadInMs) || 0));
    const leadOutMs = Math.max(0, Math.round(Number(options.leadOutMs) || 0));
    const sampleCount = Math.min(
      Math.floor(peaks.length / 2),
      Math.max(0, Math.ceil((durationMs / 1000) * peaksPerSecond)),
    );
    const timeAt = (index) => Math.min(durationMs, Math.round((index * 1000) / peaksPerSecond));
    const rawGaps = [];
    let gateOpen = false;
    let foundAudio = false;
    let silenceStart = null;

    for (let index = 0; index < sampleCount; index++) {
      const levelDb = waveformPeakDb(peaks, index);
      if (gateOpen) {
        if (levelDb < closeThresholdDb) {
          gateOpen = false;
          silenceStart = timeAt(index);
        }
        continue;
      }
      if (levelDb < openThresholdDb) continue;
      if (foundAudio && silenceStart != null) {
        const end = timeAt(index);
        if (end > silenceStart) {
          // 应用前/后端预留后再决定是否纳入移除区间
          const gapStart = Math.min(durationMs, silenceStart + leadInMs);
          const gapEnd = end - leadOutMs;
          if (gapEnd > gapStart) rawGaps.push({ start: gapStart, end: gapEnd, removed: true });
        }
      }
      foundAudio = true;
      gateOpen = true;
      silenceStart = null;
    }
    return rawGaps.filter((gap) => gap.end - gap.start >= minimumMs);
  }

  function getRemovedGapRanges(gaps) {
    const merged = [];
    normalizeGapRemoveGaps(gaps).filter((gap) => gap.removed).forEach((gap) => {
      const previous = merged[merged.length - 1];
      if (previous && gap.start <= previous.end) {
        previous.end = Math.max(previous.end, gap.end);
      } else {
        merged.push({ start: gap.start, end: gap.end });
      }
    });
    return merged;
  }

  function mapGapRemovedTime(sourceMs, gaps) {
    const source = Math.max(0, Math.round(Number(sourceMs) || 0));
    let removedBefore = 0;
    for (const gap of getRemovedGapRanges(gaps)) {
      if (source <= gap.start) break;
      if (source < gap.end) return Math.max(0, gap.start - removedBefore);
      removedBefore += gap.end - gap.start;
    }
    return Math.max(0, source - removedBefore);
  }

  function buildGapRemovedIntervals(durationMs, gaps) {
    const duration = Math.max(0, Math.round(Number(durationMs) || 0));
    const intervals = [];
    let cursor = 0;
    getRemovedGapRanges(gaps).forEach((gap) => {
      const start = Math.min(duration, Math.max(cursor, gap.start));
      const end = Math.min(duration, Math.max(start, gap.end));
      if (start > cursor) intervals.push({ start: cursor, end: start });
      cursor = Math.max(cursor, end);
    });
    if (cursor < duration) intervals.push({ start: cursor, end: duration });
    return intervals;
  }

  function quoteFfconcatPath(value) {
    const normalized = String(value || '').trim().replace(/\\/g, '/');
    return `'${normalized.replace(/'/g, "'\\''")}'`;
  }

  function buildFfconcat(mediaPath, intervals) {
    const source = String(mediaPath || '').trim();
    if (!source) return '';
    const lines = ['ffconcat version 1.0'];
    (Array.isArray(intervals) ? intervals : []).forEach((interval) => {
      const start = Math.max(0, Math.round(Number(interval?.start) || 0));
      const end = Math.max(start, Math.round(Number(interval?.end) || 0));
      if (end <= start) return;
      lines.push(`file ${quoteFfconcatPath(source)}`);
      lines.push(`inpoint ${(start / 1000).toFixed(3)}`);
      lines.push(`outpoint ${(end / 1000).toFixed(3)}`);
    });
    return `${lines.join('\n')}\n`;
  }

  // macOS 上用 ⌘（event.metaKey）替代 Ctrl；Win/Linux 仍是 Ctrl。
  function isMacPlatform(nav) {
    const n = nav || globalThis.navigator;
    if (!n) return false;
    const p = String(n.platform || n.userAgentData?.platform || '');
    return /Mac|iPhone|iPad/.test(p);
  }

  function configuredEnterAction(event, splitKey) {
    if (event?.key !== 'Enter') return null;
    const mod = event.ctrlKey || event.metaKey;
    if (event.shiftKey && mod) return 'split';
    if (event.shiftKey) return 'newline';
    if (mod) return splitKey === 'ctrl-enter' ? 'split' : 'save';
    return splitKey === 'enter' ? 'split' : 'save';
  }

  // === 字幕预览几何（preview.subtitle）===
  // preview.subtitle 以 player-wrap 归一化分数存储 {x, y, width, height}。
  // 这些纯函数不触碰 DOM，可在 node:test 下直接验证。
  const PREVIEW_MIN_WIDTH = 0.20;
  const PREVIEW_MIN_HEIGHT = 0.08;
  const DEFAULT_PREVIEW_GEOMETRY = Object.freeze({
    x: 0.175, y: 0.76, width: 0.65, height: 0.16,
  });
  // 复刻原 CSS bottom:8% 的带状：y=0.76, height=0.16 → 76%→92%，留 8% 底边距；宽度默认 65% 居中。
  // 表情包预览的默认几何：右上角小图。
  const DEFAULT_STICKER_GEOMETRY = Object.freeze({
    x: 0.73, y: 0.04, width: 0.24, height: 0.3,
  });

  function clampNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  // 把任意输入归一化为合法 geometry；非法字段回退到指定默认值。
  function normalizePreviewGeometry(value, defaults = DEFAULT_PREVIEW_GEOMETRY) {
    if (!value || typeof value !== 'object') return { ...defaults };
    const geo = {
      x: clampNumber(value.x, defaults.x),
      y: clampNumber(value.y, defaults.y),
      width: clampNumber(value.width, defaults.width),
      height: clampNumber(value.height, defaults.height),
    };
    return clampPreviewGeometry(geo);
  }

  // 把 geometry 钳制到 [0,1] + min-size + 盒子不超出播放区。
  function clampPreviewGeometry(geo) {
    const width = Math.min(1, Math.max(PREVIEW_MIN_WIDTH, Number(geo.width) || 0));
    const height = Math.min(1, Math.max(PREVIEW_MIN_HEIGHT, Number(geo.height) || 0));
    const x = Math.min(1 - width, Math.max(0, Number(geo.x) || 0));
    const y = Math.min(1 - height, Math.max(0, Number(geo.y) || 0));
    return { x, y, width, height };
  }

  // geometry -> CSS 百分比样式（left/top/width/height）。
  function previewGeometryToCss(geo) {
    const clamped = clampPreviewGeometry(geo);
    return {
      left: `${(clamped.x * 100).toFixed(4)}%`,
      top: `${(clamped.y * 100).toFixed(4)}%`,
      width: `${(clamped.width * 100).toFixed(4)}%`,
      height: `${(clamped.height * 100).toFixed(4)}%`,
    };
  }

  // 根据手柄方向和归一化增量 (dx, dy) 计算新的 geometry。
  // handle: 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
  // 增量已是 player-wrap 归一化分数（调用方用 dx/wrapWidth 算好）。
  function applyPreviewGeometryDelta(geo, handle, dx, dy) {
    const clamped = clampPreviewGeometry(geo);
    const dxN = Number(dx) || 0;
    const dyN = Number(dy) || 0;
    if (handle === 'move') {
      return clampPreviewGeometry({
        x: clamped.x + dxN,
        y: clamped.y + dyN,
        width: clamped.width,
        height: clamped.height,
      });
    }
    // 以四条边计算，保证 min-size 后再钳制到播放区内。
    let left = clamped.x;
    let top = clamped.y;
    let right = clamped.x + clamped.width;
    let bottom = clamped.y + clamped.height;
    if (handle.includes('w')) left = clamped.x + dxN;
    if (handle.includes('e')) right = clamped.x + clamped.width + dxN;
    if (handle.includes('n')) top = clamped.y + dyN;
    if (handle.includes('s')) bottom = clamped.y + clamped.height + dyN;
    // min-size：若某边缩过最小值，以对边为锚回弹。
    if (right - left < PREVIEW_MIN_WIDTH) {
      if (handle.includes('w')) left = right - PREVIEW_MIN_WIDTH;
      else right = left + PREVIEW_MIN_WIDTH;
    }
    if (bottom - top < PREVIEW_MIN_HEIGHT) {
      if (handle.includes('n')) top = bottom - PREVIEW_MIN_HEIGHT;
      else bottom = top + PREVIEW_MIN_HEIGHT;
    }
    // 钳制到播放区 [0,1]。
    left = Math.max(0, left);
    top = Math.max(0, top);
    right = Math.min(1, right);
    bottom = Math.min(1, bottom);
    // 钳制后再保证 min-size（播放区不够大时优先贴边）。
    if (right - left < PREVIEW_MIN_WIDTH) right = Math.min(1, left + PREVIEW_MIN_WIDTH);
    if (bottom - top < PREVIEW_MIN_HEIGHT) bottom = Math.min(1, top + PREVIEW_MIN_HEIGHT);
    return clampPreviewGeometry({
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
    });
  }

  // 统一撤销/重做栈：管理两个不透明记录数组。
  // - push(record)：压入 undo 栈，清空 redo 栈，按 limit 裁剪。
  // - popUndo(currentSnapshot)：从 undo 弹出一条记录，把当前快照压入 redo，
  //   返回被弹出的记录供调用方应用。空栈返回 null。
  // - popRedo(currentSnapshot)：对称地从 redo 弹出，把当前快照压入 undo。
  // 调用方负责按记录的 kind 生成 currentSnapshot 与应用记录。
  function createHistoryStack(limit = 100) {
    const max = Math.max(1, Math.round(Number(limit) || 100));
    const undo = [];
    const redo = [];
    const trim = () => { while (undo.length > max) undo.shift(); };
    return {
      undoLength: () => undo.length,
      redoLength: () => redo.length,
      canUndo: () => undo.length > 0,
      canRedo: () => redo.length > 0,
      peekUndo: () => undo[undo.length - 1] || null,
      peekRedo: () => redo[redo.length - 1] || null,
      push: (record) => {
        undo.push(record);
        trim();
        redo.length = 0;
      },
      popUndo: (currentSnapshot) => {
        if (!undo.length) return null;
        const record = undo.pop();
        redo.push(currentSnapshot);
        return record;
      },
      popRedo: (currentSnapshot) => {
        if (!redo.length) return null;
        const record = redo.pop();
        undo.push(currentSnapshot);
        trim();
        return record;
      },
      clear: () => { undo.length = 0; redo.length = 0; },
      clearRedo: () => { redo.length = 0; },
    };
  }

  window.AsrEditorUtils = {
    buildReplacementPreview,
    countTextUnits,
    cueMetrics,
    joinSegmentTexts,
    subtitleTextLength,
    isShortSubtitleText,
    normalizeSegmentTimings,
    planAutoMerge,
    applyAutoMergeSnaps,
    formatHumanDuration,
    formatGapRemoveDuration,
    splitCharOffsetAtTime,
    findAdjacentCueIndex,
    findCueNavigationTarget,
    findCueSelectionExtensionTarget,
    resolveMergedGroupInheritance,
    MULTI_SUBTITLE_SCHEMA,
    MULTI_SUBTITLE_TOLERANCE_MS,
    MULTI_SUBTITLE_DISPLAY_MODES,
    MULTI_SUBTITLE_SPLIT_MODES,
    ensureStableSegmentIds,
    uniqueStableSegmentId,
    normalizeMultiSubtitle,
    normalizeMultiSubtitleProject,
    detectSubtitleSplitMode,
    subtitleSplitOffsets,
    cleanSplitTextParts,
    splitSubtitleText,
    nearestSubtitleSplitOffset,
    hasUsableSplitTimestamps,
    bindingForSegment,
    buildSubtitleBinding,
    rebuildBindingOffsets,
    swapMainAndExtensionSubtitle,
    removeSubtitleBindings,
    matchSubtitleSegments,
    buildMultiDisplayRows,
    getSrtExportFirstIndex,
    getSrtExportOffset,
    effectiveColorName,
    shiftGroupReferenceIndices,
    repairGroupReferenceIndices,
    buildSrtPayload,
    buildPlainTextPayload,
    fileBasename,
    normalizeGapRemoveGaps,
    applyGapRemoveRange,
    resizeGapRemoveBoundary,
    detectAudioGapRemoveGaps,
    getRemovedGapRanges,
    mapGapRemovedTime,
    buildGapRemovedIntervals,
    buildFfconcat,
    configuredEnterAction,
    isMacPlatform,
    createHistoryStack,
    PREVIEW_MIN_WIDTH,
    PREVIEW_MIN_HEIGHT,
  DEFAULT_PREVIEW_GEOMETRY,
  DEFAULT_STICKER_GEOMETRY,
  normalizePreviewGeometry,
    clampPreviewGeometry,
    previewGeometryToCss,
    applyPreviewGeometryDelta,
  };
})();
