// Pure editor helpers kept separate so replacement behavior can be tested
// without constructing the full browser editor DOM.
(function () {
  'use strict';

  const SUBTITLE_FONT_FAMILY_DISPLAY_NAMES_ZH = Object.freeze({
    'Microsoft YaHei': '微软雅黑',
    'Microsoft YaHei UI': '微软雅黑',
    SimHei: '黑体',
    SimSun: '宋体',
    NSimSun: '新宋体',
    FangSong: '仿宋',
    KaiTi: '楷体',
    'PingFang SC': '苹方',
    'Heiti SC': '黑体-简',
    'Songti SC': '宋体-简',
    'Kaiti SC': '楷体-简',
    'Source Han Sans SC': '思源黑体',
    'Source Han Serif SC': '思源宋体',
    'Noto Sans CJK SC': 'Noto Sans CJK 简体中文',
    'Noto Serif CJK SC': 'Noto Serif CJK 简体中文',
  });

  function subtitleFontFamilyDisplayName(family, language) {
    if (language !== 'zh' || typeof family !== 'string') return family;
    return SUBTITLE_FONT_FAMILY_DISPLAY_NAMES_ZH[family] || family;
  }

  // SRT files commonly come from Windows subtitle tools, which may save them
  // as UTF-8 (with or without BOM) or as the local GBK code page. Decode the
  // bytes here instead of relying on File.text(), whose encoding is fixed to
  // UTF-8 and turns GBK Chinese into replacement characters.
  function decodeSubtitleText(input) {
    if (typeof input === 'string') return input.replace(/^\uFEFF/, '');
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || []);
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
      return new TextDecoder('utf-8').decode(bytes.subarray(3));
    }
    if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
      return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    }
    if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
      return new TextDecoder('utf-16be').decode(bytes.subarray(2));
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return new TextDecoder('gb18030').decode(bytes);
    }
  }

  const KEYBOARD_OPERATION_REFERENCE_MODES = new Set(['pointer', 'playhead']);

  function normalizeKeyboardOperationReferenceMode(value) {
    return KEYBOARD_OPERATION_REFERENCE_MODES.has(value) ? value : 'pointer';
  }

  function resolveKeyboardOperationReference(mode, { pointer = null, playheadTarget = null } = {}) {
    const resolvedMode = normalizeKeyboardOperationReferenceMode(mode);
    if (resolvedMode === 'pointer') {
      if (!pointer || !Number.isFinite(Number(pointer.timeMs))) return null;
      const track = pointer.track === 'extension' ? 'extension' : 'main';
      return {
        timeMs: Math.round(Number(pointer.timeMs)),
        track,
        trackId: track === 'extension' && typeof pointer.trackId === 'string'
          ? pointer.trackId : null,
        source: 'pointer',
      };
    }
    const timeMs = Number(playheadTarget?.timeMs);
    if (!Number.isFinite(timeMs)) return null;
    const track = playheadTarget?.kind === 'extension' ? 'extension' : 'main';
    return {
      timeMs: Math.round(timeMs),
      track,
      trackId: track === 'extension' && typeof playheadTarget.trackId === 'string'
        ? playheadTarget.trackId : null,
      source: 'playhead',
    };
  }

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

  function stripMarkdownFormatting(text) {
    return String(text == null ? '' : text)
      .replace(/!\[([^\]]*)\]\([^\)\n]+\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^\)\n]+\)/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s{0,3}>\s?/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/[\\*_~`]/g, '');
  }

  function capitalizeFirstLetter(text) {
    return String(text == null ? '' : text).replace(/^(\s*)(\p{L})/u, (match, leading, letter) => {
      return `${leading}${letter.toLocaleUpperCase()}`;
    });
  }

  // Apply the selected operations in a stable order so preview and execution
  // always agree: Markdown -> trim -> capitalization -> prefix -> suffix.
  function applyTextProcessing(text, options = {}) {
    let result = String(text == null ? '' : text);
    if (options.stripMarkdown) result = stripMarkdownFormatting(result);
    if (options.trim) result = result.trim();
    if (options.capitalize) result = capitalizeFirstLetter(result);
    if (options.addPrefix) result = `${String(options.prefix == null ? '' : options.prefix)}${result}`;
    if (options.addSuffix) result = `${result}${String(options.suffix == null ? '' : options.suffix)}`;
    return result;
  }

  function normalizeTextProcessingIndexes(segments, indexes) {
    const source = Array.isArray(segments) ? segments : [];
    const candidates = Array.isArray(indexes)
      ? indexes
      : source.map((_, index) => index);
    return [...new Set(candidates
      .filter((index) => Number.isInteger(index) && index >= 0 && index < source.length))]
      .sort((a, b) => a - b);
  }

  function buildTextProcessingPreview(segments, indexes, options = {}) {
    const source = Array.isArray(segments) ? segments : [];
    const targetIndexes = normalizeTextProcessingIndexes(source, indexes);
    const rows = targetIndexes.map((index) => {
      const before = String(source[index]?.text == null ? '' : source[index].text);
      const after = applyTextProcessing(before, options);
      return { index, before, after, changed: before !== after };
    });
    return {
      targetCount: rows.length,
      changedCount: rows.filter((row) => row.changed).length,
      unchangedCount: rows.filter((row) => !row.changed).length,
      rows,
    };
  }

  function timedTextTokens(text) {
    return Array.from(String(text == null ? '' : text));
  }

  function isTimedTextWhitespace(token) {
    return /\s/u.test(token);
  }

  function timedTextItemCoverageMask(text, rawItems) {
    const sourceTokens = timedTextTokens(text);
    const targetTokens = sourceTokens.filter((token) => !isTimedTextWhitespace(token));
    const items = Array.isArray(rawItems) ? rawItems : [];
    const itemTokens = [];
    const itemCoverage = [];
    let validItemCount = 0;
    items.forEach((item) => {
      const tokens = timedTextTokens(item?.text).filter((token) => !isTimedTextWhitespace(token));
      const start = Number(item?.start);
      const end = Number(item?.end);
      const validTiming = tokens.length > 0
        && Number.isFinite(start) && Number.isFinite(end) && end > start;
      if (validTiming) {
        validItemCount += 1;
      }
      itemTokens.push(...tokens);
      tokens.forEach(() => itemCoverage.push(validTiming));
    });
    const covered = new Uint8Array(targetTokens.length);
    const opcodes = timedTextDiffOpcodes(itemTokens, targetTokens);
    if (opcodes) {
      opcodes.forEach((opcode) => {
        if (opcode.tag !== 'equal') return;
        for (let offset = 0; offset < opcode.targetEnd - opcode.targetStart; offset += 1) {
          const sourceIndex = opcode.sourceStart + offset;
          const targetIndex = opcode.targetStart + offset;
          if (itemCoverage[sourceIndex]) covered[targetIndex] = 1;
        }
      });
    }
    return {
      sourceTokens: targetTokens,
      covered,
      coveredCharacters: covered.reduce((sum, value) => sum + value, 0),
      validItemCount,
      totalItemCount: items.length,
    };
  }

  function timedTextItemCoverage(text, rawItems) {
    const coverage = timedTextItemCoverageMask(text, rawItems);
    const { sourceTokens, coveredCharacters, validItemCount, totalItemCount } = coverage;
    const totalCharacters = sourceTokens.length;
    return {
      percent: totalCharacters ? Math.round((coveredCharacters / totalCharacters) * 100) : 0,
      coveredCharacters,
      totalCharacters,
      validItemCount,
      totalItemCount,
    };
  }

  // “有效覆盖率”只说明当前文字被有效时间码覆盖；“原始时间码复用率”
  // 还要扣除新增/删除后无法对应到原文字符的位置。等长改字是已确认的
  // 可靠场景：旧 item 的时间范围会按原位置复用，因此不因错别字本身降级。
  function timedTextItemReuse(originalText, originalItems, text, rawItems, mappingStatus = '') {
    const sourceCoverage = timedTextItemCoverageMask(originalText, originalItems);
    const targetCoverage = timedTextItemCoverageMask(text, rawItems);
    const sourceTokens = sourceCoverage.sourceTokens;
    const targetTokens = targetCoverage.sourceTokens;
    const totalCharacters = Math.max(sourceTokens.length, targetTokens.length);
    if (!totalCharacters || !sourceCoverage.validItemCount || !targetCoverage.coveredCharacters) {
      return {
        percent: 0,
        reusedCharacters: 0,
        totalCharacters,
        sourceCharacters: sourceTokens.length,
        currentCharacters: targetTokens.length,
      };
    }

    let reusedCharacters = 0;
    if (sourceTokens.length === targetTokens.length && mappingStatus === 'full') {
      // 等长改字分支保持每个原 item 的时间范围，按当前位置复用时间码。
      reusedCharacters = targetCoverage.coveredCharacters;
    } else {
      const opcodes = timedTextDiffOpcodes(sourceTokens, targetTokens);
      if (opcodes) {
        opcodes.forEach((opcode) => {
          if (opcode.tag !== 'equal') return;
          const length = opcode.targetEnd - opcode.targetStart;
          for (let offset = 0; offset < length; offset += 1) {
            const sourceIndex = opcode.sourceStart + offset;
            const targetIndex = opcode.targetStart + offset;
            if (sourceCoverage.covered[sourceIndex] && targetCoverage.covered[targetIndex]) {
              reusedCharacters += 1;
            }
          }
        });
      }
    }
    return {
      percent: Math.round((reusedCharacters / totalCharacters) * 100),
      reusedCharacters,
      totalCharacters,
      sourceCharacters: sourceTokens.length,
      currentCharacters: targetTokens.length,
    };
  }

  function buildTimedTextDiff(before, after) {
    const beforeTokens = timedTextTokens(before);
    const afterTokens = timedTextTokens(after);
    let prefix = 0;
    while (
      prefix < beforeTokens.length
      && prefix < afterTokens.length
      && beforeTokens[prefix] === afterTokens[prefix]
    ) prefix += 1;
    let suffix = 0;
    while (
      suffix < beforeTokens.length - prefix
      && suffix < afterTokens.length - prefix
      && beforeTokens[beforeTokens.length - 1 - suffix]
        === afterTokens[afterTokens.length - 1 - suffix]
    ) suffix += 1;
    const beforeParts = [];
    const afterParts = [];
    if (prefix) {
      const common = beforeTokens.slice(0, prefix).join('');
      beforeParts.push({ kind: 'equal', text: common });
      afterParts.push({ kind: 'equal', text: common });
    }
    const removed = beforeTokens.slice(prefix, beforeTokens.length - suffix).join('');
    const added = afterTokens.slice(prefix, afterTokens.length - suffix).join('');
    if (removed) beforeParts.push({ kind: 'remove', text: removed });
    if (added) afterParts.push({ kind: 'add', text: added });
    if (suffix) {
      const common = beforeTokens.slice(beforeTokens.length - suffix).join('');
      beforeParts.push({ kind: 'equal', text: common });
      afterParts.push({ kind: 'equal', text: common });
    }
    return {
      before: beforeParts.length ? beforeParts : [{ kind: 'equal', text: '' }],
      after: afterParts.length ? afterParts : [{ kind: 'equal', text: '' }],
      addedCharacters: timedTextTokens(added).length,
      removedCharacters: timedTextTokens(removed).length,
    };
  }

  function timedTextItemLayout(originalText, rawItems) {
    if (!Array.isArray(rawItems) || !rawItems.length) return null;
    const items = cloneJsonValue(rawItems);
    const sourceTokens = timedTextTokens(originalText);
    const spans = [];
    let previousStart = -Infinity;
    let previousEnd = -Infinity;
    for (const item of items) {
      if (!item || typeof item !== 'object') return null;
      const itemTokens = timedTextTokens(item.text);
      const start = Number(item.start);
      const end = Number(item.end);
      if (!itemTokens.length || !Number.isFinite(start) || !Number.isFinite(end)
          || end < start || start < previousStart || start < previousEnd) return null;
      const itemStart = spans.length ? spans[spans.length - 1].end : 0;
      const itemEnd = itemStart + itemTokens.length;
      spans.push({ start: itemStart, end: itemEnd });
      previousStart = start;
      previousEnd = end;
    }
    if (spans[spans.length - 1].end !== sourceTokens.length) return null;
    return { items, spans };
  }

  function timedTextItemSpans(originalText, items) {
    return timedTextItemLayout(originalText, items)?.spans || null;
  }

  function timedTextItemsSlice(layout, startBoundary, endBoundary) {
    if (!layout || !Number.isInteger(startBoundary) || !Number.isInteger(endBoundary)) return null;
    const total = layout.spans[layout.spans.length - 1]?.end || 0;
    if (startBoundary < 0 || endBoundary > total || startBoundary >= endBoundary) return [];
    return layout.items.flatMap((item, index) => {
      const span = layout.spans[index];
      const sliceStart = Math.max(startBoundary, span.start);
      const sliceEnd = Math.min(endBoundary, span.end);
      if (sliceStart >= sliceEnd) return [];
      const itemTokens = timedTextTokens(item.text);
      const localStart = sliceStart - span.start;
      const localEnd = sliceEnd - span.start;
      const itemStart = Number(item.start);
      const itemEnd = Number(item.end);
      const itemLength = Math.max(1, itemTokens.length);
      const timeAt = (offset) => Math.round(
        itemStart + ((itemEnd - itemStart) * offset) / itemLength,
      );
      const copy = cloneJsonValue(item);
      copy.text = itemTokens.slice(localStart, localEnd).join('');
      copy.start = timeAt(localStart);
      copy.end = timeAt(localEnd);
      // 被切开的 item 不再有唯一的原始身份；时间和其它可选元数据仍保留。
      if (sliceStart !== span.start || sliceEnd !== span.end) delete copy.id;
      return [copy];
    });
  }

  function timedTextItemsPartition(layout, prefixCount, suffixCount) {
    if (!layout || !Number.isInteger(prefixCount) || !Number.isInteger(suffixCount)) return null;
    const total = layout.spans[layout.spans.length - 1]?.end || 0;
    const bodyEnd = total - suffixCount;
    if (prefixCount < 0 || suffixCount < 0 || prefixCount > bodyEnd) return null;
    const prefix = timedTextItemsSlice(layout, 0, prefixCount);
    const body = timedTextItemsSlice(layout, prefixCount, bodyEnd);
    const suffix = timedTextItemsSlice(layout, bodyEnd, total);
    if (!prefix || !body || !suffix || (prefixCount < bodyEnd && !body.length)) return null;
    return { prefix, body, suffix };
  }

  function timedTextStructureRequested(segments, draftTexts) {
    const source = Array.isArray(segments) ? segments : [];
    const texts = Array.isArray(draftTexts) ? draftTexts : [];
    if (!source.length || source.some((segment) => String(segment?.text || '').includes('\n'))) return false;
    return source.length !== texts.length
      || texts.some((text) => String(text == null ? '' : text).includes('\n'));
  }

  function timedTextDraftLines(draftTexts) {
    return timedTextDraftLineEntries(draftTexts).map((entry) => entry.text);
  }

  function timedTextDraftLineEntries(draftTexts) {
    return (Array.isArray(draftTexts) ? draftTexts : [])
      .flatMap((text, draftIndex) => String(text == null ? '' : text)
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) => ({ text: line, draftIndex })));
  }

  function timedTextRangeIsWhitespace(tokens, range) {
    return tokens.slice(range.start, range.end).every((token) => /\s/u.test(token));
  }

  function retimeTimedTextSlice(items, newText) {
    const source = Array.isArray(items) ? items : [];
    const targetTokens = timedTextTokens(newText);
    const lengths = source.map((item) => timedTextTokens(item?.text).length);
    if (!source.length || lengths.some((length) => length <= 0)
        || lengths.reduce((sum, length) => sum + length, 0) !== targetTokens.length) return null;
    let offset = 0;
    return source.map((item, index) => {
      const copy = cloneJsonValue(item);
      const length = lengths[index];
      copy.text = targetTokens.slice(offset, offset + length).join('');
      offset += length;
      return copy;
    });
  }

  const TIMED_TEXT_ESTIMATED_MIN_MS = 100;
  const TIMED_TEXT_ESTIMATED_MS_PER_CHARACTER = 100;

  function timedTextEstimatedDuration(text) {
    const units = Math.max(1, Math.ceil(countTextUnits(text)));
    return Math.max(
      TIMED_TEXT_ESTIMATED_MIN_MS,
      units * TIMED_TEXT_ESTIMATED_MS_PER_CHARACTER,
    );
  }

  function timedTextSegmentBoundary(segment, offset, total) {
    const start = Number(segment?.start);
    const end = Number(segment?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || total <= 0) return null;
    const safeOffset = Math.max(0, Math.min(total, Number(offset) || 0));
    return Math.round(start + ((end - start) * safeOffset) / total);
  }

  function emptyTimedTextStructurePlan(error = '') {
    return {
      valid: false,
      type: null,
      error,
      mode: null,
      segments: [],
      outputMeta: [],
      sourceOutputIndexes: [],
      affectedSourceIndexes: [],
      removedSourceIndexes: [],
    };
  }

  function findTimedTextTokenSequence(sourceTokens, targetTokens, fromIndex) {
    if (!targetTokens.length) return -1;
    for (let index = Math.max(0, fromIndex); index + targetTokens.length <= sourceTokens.length; index += 1) {
      if (sameTimedTextTokens(
        sourceTokens.slice(index, index + targetTokens.length),
        targetTokens,
      )) return index;
    }
    return -1;
  }

  function buildTimedTextStructurePlan(segments, draftTexts) {
    const source = Array.isArray(segments) ? segments : [];
    const texts = Array.isArray(draftTexts) ? draftTexts : [];
    if (!timedTextStructureRequested(source, texts)) return emptyTimedTextStructurePlan();
    // 空行表示用户清空了对应字幕；纯文本视图不再保留空字幕行，直接将其视为删除标记。
    const lineEntries = timedTextDraftLineEntries(texts)
      .filter((entry) => String(entry.text).trim() !== '');
    const lines = lineEntries.map((entry) => entry.text);

    const sourceTokens = source.map((segment) => timedTextTokens(segment?.text));
    const sourceOffsets = [];
    let totalCharacters = 0;
    sourceTokens.forEach((tokens) => {
      sourceOffsets.push({ start: totalCharacters, end: totalCharacters + tokens.length });
      totalCharacters += tokens.length;
    });
    if (!totalCharacters) return emptyTimedTextStructurePlan('当前字幕没有可用于拆分的文字。');
    const flattenedSource = sourceTokens.flat();
    const lineTokens = lines.map((line) => timedTextTokens(line));
    const lineRanges = [];
    let exactCursor = 0;
    let exact = true;
    for (const tokens of lineTokens) {
      const start = findTimedTextTokenSequence(flattenedSource, tokens, exactCursor);
      if (start < 0) {
        exact = false;
        break;
      }
      lineRanges.push({ start, end: start + tokens.length });
      exactCursor = start + tokens.length;
    }

    let mode = 'exact';
    if (exact) {
      const gaps = [];
      let previous = 0;
      lineRanges.forEach((range) => {
        if (range.start > previous) gaps.push({ start: previous, end: range.start });
        previous = range.end;
      });
      if (previous < totalCharacters) gaps.push({ start: previous, end: totalCharacters });
      const boundaries = new Set([0, ...sourceOffsets.flatMap((range) => [range.start, range.end])]);
      if (gaps.some((gap) => (
        (!boundaries.has(gap.start) || !boundaries.has(gap.end))
        && !timedTextRangeIsWhitespace(flattenedSource, gap)
      ))) {
        return emptyTimedTextStructurePlan('删除字幕时只能删除完整字幕行，不能只删除其中一部分文字。');
      }
    } else {
      // 某些前面的句子被改写后，仍尝试从后面的未改文字建立锚点。
      // 锚点之间的新增/改写区域只允许走字幕段级估算，不能再按原始 index 猜。
      const anchors = Array.from({ length: lineTokens.length }, () => null);
      let cursor = 0;
      let anchorCount = 0;
      lineTokens.forEach((tokens, index) => {
        const start = findTimedTextTokenSequence(flattenedSource, tokens, cursor);
        if (start < 0) return;
        anchors[index] = { start, end: start + tokens.length };
        cursor = start + tokens.length;
        anchorCount += 1;
      });
      if (!anchorCount) {
        return emptyTimedTextStructurePlan('无法根据原文重新匹配拆句结果；请保留至少一段未改文字作为匹配锚点。');
      }
      mode = 'anchor';
      let previousLineIndex = -1;
      let previousSourceEnd = 0;
      const anchorIndexes = anchors
        .map((anchor, index) => (anchor ? index : -1))
        .filter((index) => index >= 0);
      for (const nextLineIndex of [...anchorIndexes, lineTokens.length]) {
        const nextAnchor = nextLineIndex < lineTokens.length ? anchors[nextLineIndex] : null;
        const sourceEnd = nextAnchor?.start ?? totalCharacters;
        const missingIndexes = [];
        for (let index = previousLineIndex + 1; index < nextLineIndex; index += 1) {
          if (!anchors[index]) missingIndexes.push(index);
        }
        const targetLength = missingIndexes.reduce((sum, index) => sum + lineTokens[index].length, 0);
        const sourceLength = sourceEnd - previousSourceEnd;
        if (missingIndexes.length && (targetLength <= 0 || sourceLength <= 0)) {
          return emptyTimedTextStructurePlan('无法根据原文重新匹配拆句结果；改写区域缺少可用时间范围。');
        }
        let targetOffset = 0;
        missingIndexes.forEach((index) => {
          const start = previousSourceEnd + Math.round((sourceLength * targetOffset) / targetLength);
          targetOffset += lineTokens[index].length;
          const end = previousSourceEnd + Math.round((sourceLength * targetOffset) / targetLength);
          if (end <= start) {
            lineRanges.length = 0;
            return;
          }
          lineRanges[index] = { start, end };
        });
        if (nextAnchor) {
          lineRanges[nextLineIndex] = nextAnchor;
          previousLineIndex = nextLineIndex;
          previousSourceEnd = nextAnchor.end;
        } else {
          previousLineIndex = lineTokens.length - 1;
          previousSourceEnd = totalCharacters;
        }
      }
      if (lineRanges.length !== lineTokens.length || lineRanges.some((range) => !range)) {
        return emptyTimedTextStructurePlan('无法根据原文重新匹配拆句结果；请减少连续改写的字幕行。');
      }
    }

    const layouts = source.map((segment) => timedTextItemLayout(segment?.text, segment?.items));
    const outputSegments = [];
    const outputMeta = [];
    const sourceOutputIndexes = Array.from({ length: source.length }, () => []);
    let previousOutputEnd = null;
    for (const [outputIndex, range] of lineRanges.entries()) {
      const overlaps = sourceOffsets
        .map((sourceRange, sourceIndex) => ({ sourceRange, sourceIndex }))
        .filter(({ sourceRange }) => range.start < sourceRange.end && range.end > sourceRange.start);
      if (!overlaps.length) return emptyTimedTextStructurePlan('无法找到新字幕对应的原始时间范围。');

      const first = overlaps[0].sourceIndex;
      const last = overlaps[overlaps.length - 1].sourceIndex;
      const firstLocal = range.start - sourceOffsets[first].start;
      const lastLocal = range.end - sourceOffsets[last].start;
      const isWholeUnchangedSource = overlaps.length === 1
        && firstLocal === 0
        && lastLocal === sourceTokens[first].length
        && lines[outputIndex] === String(source[first]?.text || '');
      let items = null;
      let timingEstimated = false;
      if (isWholeUnchangedSource) {
        // 末尾多出的空行等不会改变字幕结构；没有字词时间码时也可以安全地保留这个无变化行。
        items = Array.isArray(source[first]?.items) ? cloneJsonValue(source[first].items) : null;
      } else {
        const originalItems = [];
        let canReuseItems = true;
        for (const { sourceRange, sourceIndex } of overlaps) {
          const localStart = Math.max(0, range.start - sourceRange.start);
          const localEnd = Math.min(sourceRange.end - sourceRange.start, range.end - sourceRange.start);
          if (localStart >= localEnd) continue;
          if (!layouts[sourceIndex]) {
            canReuseItems = false;
            break;
          }
          const slice = timedTextItemsSlice(layouts[sourceIndex], localStart, localEnd);
          if (!slice?.length) {
            canReuseItems = false;
            break;
          }
          originalItems.push(...slice);
        }
        items = canReuseItems ? retimeTimedTextSlice(originalItems, lines[outputIndex]) : null;
        if (!items?.length || !timedTextItemsOrdered(items)) {
          // 没有完整字词时间码时仍允许拆句，但只生成字幕段级时间范围，
          // 并在报告中明确标记为按范围/字数估算，绝不伪造精确 items。
          items = null;
          timingEstimated = true;
        }
      }
      let start = items?.length
        ? (firstLocal === 0 ? Number(source[first]?.start) : Number(items[0].start))
        : timedTextSegmentBoundary(source[first], firstLocal, sourceTokens[first].length);
      let end = items?.length
        ? (lastLocal === sourceTokens[last].length
          ? Number(source[last]?.end) : Number(items[items.length - 1].end))
        : timedTextSegmentBoundary(source[last], lastLocal, sourceTokens[last].length);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        timingEstimated = true;
        start = Number.isFinite(previousOutputEnd) ? previousOutputEnd : 0;
        end = start + timedTextEstimatedDuration(lines[outputIndex]);
      } else if (timingEstimated) {
        if (Number.isFinite(previousOutputEnd) && start < previousOutputEnd) start = previousOutputEnd;
        end = Math.max(end, start + TIMED_TEXT_ESTIMATED_MIN_MS);
      }
      const nextSourceStart = Number(source[last + 1]?.start);
      if (timingEstimated && Number.isFinite(nextSourceStart)) {
        if (start >= nextSourceStart) {
          return emptyTimedTextStructurePlan('自动估算的字幕时间范围没有足够空间，不能越过下一条字幕的开头。');
        }
        end = Math.min(end, nextSourceStart);
        if (end - start < TIMED_TEXT_ESTIMATED_MIN_MS) {
          return emptyTimedTextStructurePlan('自动估算的字幕时间范围不足 100ms，且不能越过下一条字幕的开头。');
        }
      }
      if (end <= start) {
        return emptyTimedTextStructurePlan('拆句后产生了无效的字幕时间范围。');
      }
      const segment = cloneJsonValue(source[first] || {});
      segment.start = start;
      segment.end = end;
      segment.text = lines[outputIndex];
      if (!isWholeUnchangedSource) {
        if (items?.length) segment.items = items;
        else delete segment.items;
      }
      outputSegments.push(segment);
      outputMeta.push({
        sourceIndexes: overlaps.map(({ sourceIndex }) => sourceIndex),
        range,
        timingEstimated,
        draftIndex: lineEntries[outputIndex]?.draftIndex,
      });
      overlaps.forEach(({ sourceIndex }) => sourceOutputIndexes[sourceIndex].push(outputIndex));
      previousOutputEnd = end;
    }

    const usedSegments = [...source];
    outputMeta.forEach((meta, outputIndex) => {
      const sourceIndex = meta.sourceIndexes[0];
      const sourceSegment = source[sourceIndex] || {};
      const sourceRange = sourceOffsets[sourceIndex];
      const firstOutputForSource = sourceOutputIndexes[sourceIndex][0] === outputIndex;
      const canKeepSourceId = firstOutputForSource && meta.range.start === sourceRange.start;
      if (canKeepSourceId && sourceSegment.id) {
        outputSegments[outputIndex].id = sourceSegment.id;
      } else {
        const baseId = `${sourceSegment.id || `segment-${sourceIndex + 1}`}-text-${outputIndex + 1}`;
        outputSegments[outputIndex].id = uniqueStableSegmentId(usedSegments, baseId, 'segment');
      }
      usedSegments.push(outputSegments[outputIndex]);
      if (sourceSegment.sticker && !firstOutputForSource) {
        outputSegments[outputIndex].sticker = null;
        outputSegments[outputIndex].sticker_ref = {
          name: sourceSegment.sticker.name,
          headIdx: sourceOutputIndexes[sourceIndex][0],
        };
      }
      if (sourceSegment.color && !firstOutputForSource) {
        outputSegments[outputIndex].color = null;
        outputSegments[outputIndex].color_ref = {
          name: sourceSegment.color.name,
          headIdx: sourceOutputIndexes[sourceIndex][0],
        };
      }
    });

    const affectedSourceIndexes = [];
    sourceOutputIndexes.forEach((outputIndexes, sourceIndex) => {
      if (outputIndexes.length !== 1) {
        affectedSourceIndexes.push(sourceIndex);
        return;
      }
      const meta = outputMeta[outputIndexes[0]];
      const range = sourceOffsets[sourceIndex];
      const output = outputSegments[outputIndexes[0]];
      if (meta.sourceIndexes.length !== 1
          || meta.range.start !== range.start
          || meta.range.end !== range.end
          || output.text !== source[sourceIndex]?.text) affectedSourceIndexes.push(sourceIndex);
    });

    const removedSourceIndexes = sourceOutputIndexes
      .map((outputIndexes, sourceIndex) => outputIndexes.length ? -1 : sourceIndex)
      .filter((index) => index >= 0);
    const hasSplit = sourceOutputIndexes.some((indexes) => indexes.length > 1);
    const hasMerge = outputMeta.some((meta) => meta.sourceIndexes.length > 1);
    const hasDelete = removedSourceIndexes.length > 0;
    const type = [hasSplit ? 'split' : '', hasMerge ? 'merge' : '', hasDelete ? 'delete' : '']
      .filter(Boolean).join('+');
    return {
      valid: true,
      type: type || 'resegment',
      error: '',
      mode,
      segments: outputSegments,
      outputMeta,
      sourceOutputIndexes,
      affectedSourceIndexes,
      removedSourceIndexes,
    };
  }

  function sameTimedTextTokens(left, right) {
    return left.length === right.length && left.every((token, index) => token === right[index]);
  }

  function hasTimedTextContent(tokens) {
    return tokens.some((token) => token.trim() !== '');
  }

  function detectTimedTextBoundaryMoves(segments, draftTexts) {
    const source = Array.isArray(segments) ? segments : [];
    const texts = Array.isArray(draftTexts) ? draftTexts : [];
    if (source.length !== texts.length) return [];
    const candidates = [];

    // 当前字幕的开头移到上一条末尾：上一条新增的尾巴必须完整来自当前字幕开头。
    for (let index = 1; index < source.length; index += 1) {
      const previousBefore = timedTextTokens(source[index - 1]?.text);
      const previousAfter = timedTextTokens(texts[index - 1]);
      const currentBefore = timedTextTokens(source[index]?.text);
      if (previousAfter.length <= previousBefore.length) continue;
      const moved = previousAfter.slice(previousBefore.length);
      if (!hasTimedTextContent(moved)
          || !sameTimedTextTokens(previousAfter.slice(0, previousBefore.length), previousBefore)
          || !sameTimedTextTokens(currentBefore.slice(0, moved.length), moved)) continue;
      candidates.push({
        type: 'prefix-to-previous',
        sourceIndex: index,
        targetIndex: index - 1,
        movedTokens: moved,
      });
    }

    // 当前字幕的结尾移到下一条开头：下一条新增的开头必须完整来自当前字幕结尾。
    for (let index = 0; index < source.length - 1; index += 1) {
      const currentBefore = timedTextTokens(source[index]?.text);
      const nextBefore = timedTextTokens(source[index + 1]?.text);
      const nextAfter = timedTextTokens(texts[index + 1]);
      if (nextAfter.length <= nextBefore.length) continue;
      const moved = nextAfter.slice(0, nextAfter.length - nextBefore.length);
      if (!hasTimedTextContent(moved)
          || !sameTimedTextTokens(nextAfter.slice(moved.length), nextBefore)
          || !sameTimedTextTokens(currentBefore.slice(currentBefore.length - moved.length), moved)) continue;
      candidates.push({
        type: 'suffix-to-next',
        sourceIndex: index,
        targetIndex: index + 1,
        movedTokens: moved,
      });
    }
    return candidates;
  }

  function timedTextItemsOrdered(items) {
    let previousStart = -Infinity;
    let previousEnd = -Infinity;
    return (items || []).every((item) => {
      const start = Number(item?.start);
      const end = Number(item?.end);
      const valid = Number.isFinite(start) && Number.isFinite(end)
        && end >= start && start >= previousStart && start >= previousEnd && end >= previousEnd;
      if (valid) {
        previousStart = start;
        previousEnd = end;
      }
      return valid;
    });
  }

  // 逐条字幕通常很短，用 LCS 生成字符级 diff 足够可靠；过大的单条文本
  // 走保守兜底，避免编辑器因构造过大的二维表而卡住。
  function timedTextDiffOpcodes(sourceTokens, targetTokens) {
    const sourceLength = sourceTokens.length;
    const targetLength = targetTokens.length;
    const columns = targetLength + 1;
    const cellCount = (sourceLength + 1) * columns;
    if (cellCount > 2000000) return null;

    const table = new Uint32Array(cellCount);
    for (let sourceIndex = sourceLength - 1; sourceIndex >= 0; sourceIndex -= 1) {
      const row = sourceIndex * columns;
      const nextRow = (sourceIndex + 1) * columns;
      for (let targetIndex = targetLength - 1; targetIndex >= 0; targetIndex -= 1) {
        table[row + targetIndex] = sourceTokens[sourceIndex] === targetTokens[targetIndex]
          ? table[nextRow + targetIndex + 1] + 1
          : Math.max(table[nextRow + targetIndex], table[row + targetIndex + 1]);
      }
    }

    const opcodes = [];
    let sourcePosition = 0;
    let targetPosition = 0;
    let pendingSourceStart = null;
    let pendingTargetStart = null;
    const flushChanged = () => {
      if (pendingSourceStart === null) return;
      opcodes.push({
        tag: 'replace',
        sourceStart: pendingSourceStart,
        sourceEnd: sourcePosition,
        targetStart: pendingTargetStart,
        targetEnd: targetPosition,
      });
      pendingSourceStart = null;
      pendingTargetStart = null;
    };
    const appendEqual = () => {
      const previous = opcodes[opcodes.length - 1];
      if (previous?.tag === 'equal'
          && previous.sourceEnd === sourcePosition
          && previous.targetEnd === targetPosition) {
        previous.sourceEnd += 1;
        previous.targetEnd += 1;
      } else {
        opcodes.push({
          tag: 'equal',
          sourceStart: sourcePosition,
          sourceEnd: sourcePosition + 1,
          targetStart: targetPosition,
          targetEnd: targetPosition + 1,
        });
      }
    };

    while (sourcePosition < sourceLength && targetPosition < targetLength) {
      if (sourceTokens[sourcePosition] === targetTokens[targetPosition]) {
        flushChanged();
        appendEqual();
        sourcePosition += 1;
        targetPosition += 1;
        continue;
      }
      if (pendingSourceStart === null) {
        pendingSourceStart = sourcePosition;
        pendingTargetStart = targetPosition;
      }
      const skipSource = table[(sourcePosition + 1) * columns + targetPosition];
      const skipTarget = table[sourcePosition * columns + targetPosition + 1];
      if (skipSource >= skipTarget) sourcePosition += 1;
      else targetPosition += 1;
    }
    if (pendingSourceStart === null && (sourcePosition < sourceLength || targetPosition < targetLength)) {
      pendingSourceStart = sourcePosition;
      pendingTargetStart = targetPosition;
    }
    sourcePosition = sourceLength;
    targetPosition = targetLength;
    flushChanged();
    return opcodes;
  }

  function emptyTimedTextBoundaryPlan(source) {
    return {
      transfers: [],
      updates: Array.from({ length: source.length }, () => null),
    };
  }

  function buildTimedTextBoundaryPlan(segments, draftTexts) {
    const source = Array.isArray(segments) ? segments : [];
    const texts = Array.isArray(draftTexts) ? draftTexts : [];
    if (source.length !== texts.length) return emptyTimedTextBoundaryPlan(source);
    const candidates = detectTimedTextBoundaryMoves(source, texts);
    if (!candidates.length) return emptyTimedTextBoundaryPlan(source);

    const prefixCounts = Array.from({ length: source.length }, () => 0);
    const suffixCounts = Array.from({ length: source.length }, () => 0);
    const incomingPrefixes = Array.from({ length: source.length }, () => null);
    const incomingSuffixes = Array.from({ length: source.length }, () => null);
    for (const candidate of candidates) {
      const movedLength = candidate.movedTokens.length;
      if (candidate.type === 'prefix-to-previous') {
        if (prefixCounts[candidate.sourceIndex] || incomingSuffixes[candidate.targetIndex]) {
          return emptyTimedTextBoundaryPlan(source);
        }
        prefixCounts[candidate.sourceIndex] = movedLength;
        incomingSuffixes[candidate.targetIndex] = candidate;
      } else {
        if (suffixCounts[candidate.sourceIndex] || incomingPrefixes[candidate.targetIndex]) {
          return emptyTimedTextBoundaryPlan(source);
        }
        suffixCounts[candidate.sourceIndex] = movedLength;
        incomingPrefixes[candidate.targetIndex] = candidate;
      }
    }

    const partitions = Array.from({ length: source.length }, () => null);
    const affectedIndexes = new Set();
    candidates.forEach((candidate) => {
      affectedIndexes.add(candidate.sourceIndex);
      affectedIndexes.add(candidate.targetIndex);
    });

    for (const index of affectedIndexes) {
      const beforeTokens = timedTextTokens(source[index]?.text);
      const prefixCount = prefixCounts[index];
      const suffixCount = suffixCounts[index];
      if (prefixCount + suffixCount > beforeTokens.length) {
        return emptyTimedTextBoundaryPlan(source);
      }
      const layout = timedTextItemLayout(source[index]?.text, source[index]?.items);
      if (!layout) return emptyTimedTextBoundaryPlan(source);
      const partition = timedTextItemsPartition(layout, prefixCount, suffixCount);
      if (!partition) {
        return emptyTimedTextBoundaryPlan(source);
      }
      partitions[index] = { layout, ...partition };
    }

    for (const candidate of candidates) {
      const partition = partitions[candidate.sourceIndex];
      candidate.movedItems = candidate.type === 'prefix-to-previous'
        ? cloneJsonValue(partition.prefix)
        : cloneJsonValue(partition.suffix);
      if (!candidate.movedItems.length
          || candidate.movedItems.map((item) => item.text).join('') !== candidate.movedTokens.join('')) {
        return emptyTimedTextBoundaryPlan(source);
      }
    }

    for (const index of affectedIndexes) {
      const beforeTokens = timedTextTokens(source[index]?.text);
      const prefixTokens = incomingPrefixes[index]?.movedTokens || [];
      const suffixTokens = incomingSuffixes[index]?.movedTokens || [];
      const bodyTokens = beforeTokens.slice(prefixCounts[index], beforeTokens.length - suffixCounts[index]);
      const expectedTokens = [...prefixTokens, ...bodyTokens, ...suffixTokens];
      if (!sameTimedTextTokens(expectedTokens, timedTextTokens(texts[index]))) {
        return emptyTimedTextBoundaryPlan(source);
      }

      const partition = partitions[index];
      const incomingPrefixItems = incomingPrefixes[index]?.movedItems || [];
      const incomingSuffixItems = incomingSuffixes[index]?.movedItems || [];
      const nextItems = [
        ...cloneJsonValue(incomingPrefixItems),
        ...cloneJsonValue(partition.body),
        ...cloneJsonValue(incomingSuffixItems),
      ];
      if ((expectedTokens.length && !nextItems.length)
          || nextItems.map((item) => item.text).join('') !== expectedTokens.join('')
          || !timedTextItemsOrdered(nextItems)) {
        return emptyTimedTextBoundaryPlan(source);
      }

      const segment = source[index];
      let start = Number(segment?.start);
      let end = Number(segment?.end);
      if (nextItems.length) {
        if (prefixCounts[index] || prefixTokens.length) start = Number(nextItems[0].start);
        if (suffixCounts[index] || suffixTokens.length) end = Number(nextItems[nextItems.length - 1].end);
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        return emptyTimedTextBoundaryPlan(source);
      }
      partitions[index].update = {
        text: texts[index],
        items: nextItems,
        start,
        end,
      };
    }

    const updates = Array.from({ length: source.length }, () => null);
    affectedIndexes.forEach((index) => { updates[index] = partitions[index].update; });
    return {
      transfers: candidates.map((candidate) => ({
        type: candidate.type,
        sourceIndex: candidate.sourceIndex,
        targetIndex: candidate.targetIndex,
        movedText: candidate.movedTokens.join(''),
        movedItemCount: candidate.movedItems.length,
      })),
      updates,
    };
  }

  function reconcileTimedTextItems(originalText, rawItems, newText) {
    if (!Array.isArray(rawItems) || !rawItems.length) {
      return { status: 'unavailable', items: null, preservedItems: 0, affectedItems: 0 };
    }
    const layout = timedTextItemLayout(originalText, rawItems);
    if (!layout) {
      const items = Array.isArray(rawItems) ? cloneJsonValue(rawItems) : [];
      return { status: 'lost', items: null, preservedItems: 0, affectedItems: items.length };
    }
    const { items, spans } = layout;
    if (originalText === newText) {
      return { status: 'full', items, preservedItems: items.length, affectedItems: 0 };
    }

    const originalTokens = timedTextTokens(originalText);
    const newTokens = timedTextTokens(newText);
    // 等长改字是最可靠的错别字修正场景：按原 item 的字符长度重新分配文字，
    // 直接保留每个 item 的时间范围。
    if (originalTokens.length === newTokens.length) {
      let offset = 0;
      items.forEach((item, index) => {
        const length = spans[index].end - spans[index].start;
        item.text = newTokens.slice(offset, offset + length).join('');
        offset += length;
      });
      return { status: 'full', items, preservedItems: items.length, affectedItems: 0 };
    }

    const opcodes = timedTextDiffOpcodes(originalTokens, newTokens);
    if (!opcodes) {
      return { status: 'lost', items: null, preservedItems: 0, affectedItems: items.length };
    }
    const unchanged = opcodes.reduce((total, opcode) => (
      opcode.tag === 'equal' ? total + opcode.sourceEnd - opcode.sourceStart : total
    ), 0);
    const comparableLength = Math.max(1, Math.min(originalTokens.length, newTokens.length));
    const changedOriginal = originalTokens.length - unchanged;
    const changedTarget = newTokens.length - unchanged;
    const sourceFullyAnchored = unchanged === originalTokens.length;
    if (
      unchanged === 0
      || (!sourceFullyAnchored && unchanged < Math.max(1, Math.round(comparableLength * 0.25)))
      || (!sourceFullyAnchored && changedOriginal > originalTokens.length * 0.75)
      || (!sourceFullyAnchored && changedTarget > newTokens.length * 0.75)
    ) {
      return { status: 'lost', items: null, preservedItems: 0, affectedItems: items.length };
    }

    const affectedIndexes = new Set();
    const parentIndexes = Array.from({ length: items.length }, (_, index) => index);
    const findParent = (index) => {
      let root = index;
      while (parentIndexes[root] !== root) root = parentIndexes[root];
      while (parentIndexes[index] !== index) {
        const next = parentIndexes[index];
        parentIndexes[index] = root;
        index = next;
      }
      return root;
    };
    const unionItems = (left, right) => {
      const leftRoot = findParent(left);
      const rightRoot = findParent(right);
      if (leftRoot === rightRoot) return;
      parentIndexes[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
    };
    const indexesForSourceRange = (sourceStart, sourceEnd) => (
      sourceStart < sourceEnd
        ? spans
          .map((span, index) => ({ span, index }))
          .filter(({ span }) => span.end > sourceStart && span.start < sourceEnd)
          .map(({ index }) => index)
        : []
    );
    const insertionItemIndex = (position) => {
      if (position <= spans[0].start) return 0;
      const lastIndex = spans.length - 1;
      if (position >= spans[lastIndex].end) return lastIndex;
      for (let index = 0; index < spans.length; index += 1) {
        const span = spans[index];
        if (span.start < position && position < span.end) return index;
        // 插入在 item 边界时归到前一个 item，避免无关的后一个 item 也被合并。
        if (position === span.start) return Math.max(0, index - 1);
      }
      return lastIndex;
    };
    opcodes.forEach((opcode) => {
      if (opcode.tag === 'equal') return;
      const indexes = indexesForSourceRange(opcode.sourceStart, opcode.sourceEnd);
      if (!indexes.length) {
        const index = insertionItemIndex(opcode.sourceStart);
        if (Number.isInteger(index)) indexes.push(index);
      }
      indexes.forEach((index) => affectedIndexes.add(index));
      for (let index = 1; index < indexes.length; index += 1) {
        unionItems(indexes[0], indexes[index]);
      }
    });
    if (!affectedIndexes.size) {
      return { status: 'lost', items: null, preservedItems: 0, affectedItems: items.length };
    }

    const componentsByRoot = new Map();
    affectedIndexes.forEach((index) => {
      const root = findParent(index);
      const component = componentsByRoot.get(root);
      if (component) {
        component.start = Math.min(component.start, index);
        component.end = Math.max(component.end, index);
      } else {
        componentsByRoot.set(root, { start: index, end: index });
      }
    });
    const components = [...componentsByRoot.values()];
    const componentIds = new Map();
    [...componentsByRoot.keys()].forEach((root, componentId) => {
      componentIds.set(root, componentId);
    });
    const itemOwnerKey = (index) => {
      const componentId = componentIds.get(findParent(index));
      return componentId === undefined ? `item:${index}` : `affected:${componentId}`;
    };

    const targetKeys = [];
    for (const opcode of opcodes) {
      if (opcode.tag === 'equal') {
        for (let sourceIndex = opcode.sourceStart; sourceIndex < opcode.sourceEnd; sourceIndex += 1) {
          const itemIndex = spans.findIndex((span) => span.start <= sourceIndex && sourceIndex < span.end);
          if (itemIndex < 0) {
            return { status: 'lost', items: null, preservedItems: 0, affectedItems: items.length };
          }
          targetKeys.push(itemOwnerKey(itemIndex));
        }
        continue;
      }
      if (opcode.targetStart >= opcode.targetEnd) continue;
      const indexes = indexesForSourceRange(opcode.sourceStart, opcode.sourceEnd);
      if (!indexes.length) {
        const index = insertionItemIndex(opcode.sourceStart);
        if (Number.isInteger(index)) indexes.push(index);
      }
      if (!indexes.length) {
        return { status: 'lost', items: null, preservedItems: 0, affectedItems: items.length };
      }
      const ownerKey = itemOwnerKey(indexes[0]);
      for (let targetIndex = opcode.targetStart; targetIndex < opcode.targetEnd; targetIndex += 1) {
        targetKeys.push(ownerKey);
      }
    }

    const runs = [];
    targetKeys.forEach((key, index) => {
      const previous = runs[runs.length - 1];
      if (previous?.key === key) previous.end = index + 1;
      else runs.push({ key, start: index, end: index + 1 });
    });
    const usedKeys = new Set();
    const reconciled = [];
    for (const run of runs) {
      if (usedKeys.has(run.key)) {
        return { status: 'lost', items: null, preservedItems: 0, affectedItems: items.length };
      }
      usedKeys.add(run.key);
      const text = newTokens.slice(run.start, run.end).join('');
      if (!text) continue;
      let item;
      if (run.key.startsWith('item:')) {
        item = cloneJsonValue(items[Number(run.key.slice(5))]);
      } else {
        const component = components[Number(run.key.slice(9))];
        item = cloneJsonValue(items[component.start]);
        item.start = items[component.start].start;
        item.end = items[component.end].end;
      }
      item.text = text;
      reconciled.push(item);
    }
    if (reconciled.length && reconciled.map((item) => item.text).join('') === newText) {
      return {
        status: 'partial',
        items: reconciled,
        preservedItems: reconciled.length,
        affectedItems: affectedIndexes.size,
      };
    }
    return { status: 'lost', items: null, preservedItems: 0, affectedItems: items.length };
  }

  function buildTimedTextEditReportFixed(segments, draftTexts) {
    const source = Array.isArray(segments) ? segments : [];
    const texts = Array.isArray(draftTexts) ? draftTexts : [];
    const valid = source.length === texts.length;
    const boundaryPlan = buildTimedTextBoundaryPlan(source, texts);
    const rows = source.map((segment, index) => {
      const before = String(segment?.text == null ? '' : segment.text);
      const after = String(texts[index] == null ? '' : texts[index]);
      const diff = buildTimedTextDiff(before, after);
      const boundary = boundaryPlan.updates[index];
      const mapping = boundary
        ? {
          status: 'boundary',
          items: boundary.items,
          preservedItems: boundary.items.length,
          affectedItems: boundary.items.length,
        }
        : reconcileTimedTextItems(before, segment?.items, after);
      const afterStart = boundary ? boundary.start : Number(segment?.start);
      const afterEnd = boundary ? boundary.end : Number(segment?.end);
      const coverage = timedTextItemCoverage(after, mapping.items);
      const reuse = timedTextItemReuse(
        before, segment?.items, after, mapping.items, mapping.status,
      );
      return {
        index,
        before,
        after,
        changed: before !== after,
        deleted: Boolean(before.trim() && !after.trim()),
        diff,
        mappingStatus: mapping.status,
        beforeItemCount: Array.isArray(segment?.items) ? segment.items.length : 0,
        afterItemCount: mapping.items?.length || 0,
        preservedItems: mapping.preservedItems,
        affectedItems: mapping.affectedItems,
        items: mapping.items,
        itemCoverage: coverage.percent,
        itemCoverageData: coverage,
        itemReuse: reuse.percent,
        itemReuseData: reuse,
        beforeStart: Number(segment?.start),
        beforeEnd: Number(segment?.end),
        afterStart,
        afterEnd,
        timingChanged: afterStart !== Number(segment?.start) || afterEnd !== Number(segment?.end),
      };
    });
    const changedRows = rows.filter((row) => row.changed);
    const stats = {
      totalSegments: source.length,
      changedSegments: changedRows.length,
      unchangedSegments: rows.length - changedRows.length,
      beforeCharacters: rows.reduce((sum, row) => sum + timedTextTokens(row.before).length, 0),
      afterCharacters: rows.reduce((sum, row) => sum + timedTextTokens(row.after).length, 0),
      addedCharacters: changedRows.reduce((sum, row) => sum + row.diff.addedCharacters, 0),
      removedCharacters: changedRows.reduce((sum, row) => sum + row.diff.removedCharacters, 0),
      fullMappedCues: changedRows.filter((row) => row.mappingStatus === 'full').length,
      partialMappedCues: changedRows.filter((row) => row.mappingStatus === 'partial').length,
      lostMappedCues: changedRows.filter((row) => row.mappingStatus === 'lost').length,
      unavailableMappedCues: changedRows.filter((row) => row.mappingStatus === 'unavailable').length,
      boundaryMappedCues: changedRows.filter((row) => row.mappingStatus === 'boundary').length,
      boundaryMoves: boundaryPlan.transfers.length,
      timingChangedCues: rows.filter((row) => row.timingChanged).length,
      preservedItems: changedRows.reduce((sum, row) => sum + row.preservedItems, 0),
      affectedItems: changedRows.reduce((sum, row) => sum + row.affectedItems, 0),
    };
    return { valid, rows, changedRows, stats, boundaryMoves: boundaryPlan.transfers };
  }

  function timedTextStructureSourceSlice(source, range) {
    const sourceSegments = Array.isArray(source) ? source : [];
    const requestedStart = Math.max(0, Math.round(Number(range?.start) || 0));
    const requestedEnd = Math.max(requestedStart, Math.round(Number(range?.end) || 0));
    const textParts = [];
    const items = [];
    let offset = 0;
    sourceSegments.forEach((segment) => {
      const tokens = timedTextTokens(segment?.text);
      const sourceStart = offset;
      const sourceEnd = offset + tokens.length;
      offset = sourceEnd;
      const localStart = Math.max(0, requestedStart - sourceStart);
      const localEnd = Math.min(tokens.length, requestedEnd - sourceStart);
      if (localStart >= localEnd) return;
      textParts.push(tokens.slice(localStart, localEnd).join(''));
      const layout = timedTextItemLayout(segment?.text, segment?.items);
      if (layout) {
        const sliced = timedTextItemsSlice(layout, localStart, localEnd);
        if (sliced) items.push(...sliced);
      }
    });
    return { text: textParts.join(''), items };
  }

  function buildTimedTextStructureReport(source, texts, plan) {
    const outputRows = plan.segments.map((output, outputIndex) => {
      const meta = plan.outputMeta[outputIndex] || { sourceIndexes: [], range: null };
      const sourceSlice = timedTextStructureSourceSlice(source, meta.range);
      const sourceIndexes = Array.isArray(meta.sourceIndexes) ? meta.sourceIndexes : [];
      const structural = sourceIndexes.some((index) => plan.affectedSourceIndexes.includes(index))
        || sourceIndexes.length !== 1;
      // 结构拆分时，每个输出行只对应原字幕的一段时间范围，但“修改前”
      // 应该展示用户实际拆分的整条原字幕，而不是展示与“修改后”相同的切片。
      // 例如「超高速摄影机」拆成「超高速」/「摄影机」时，两行都以整句为 before。
      const fullSourceText = sourceIndexes
        .map((index) => String(source[index]?.text == null ? '' : source[index].text))
        .join('');
      const before = structural && fullSourceText ? fullSourceText : sourceSlice.text;
      const after = String(output?.text || '');
      const mappingStatus = structural
        ? 'structure'
        : reconcileTimedTextItems(before, sourceSlice.items, after).status;
      const coverage = timedTextItemCoverage(after, output?.items);
      const reuse = timedTextItemReuse(
        before,
        sourceSlice.items,
        after,
        output?.items,
        before === after ? 'full' : mappingStatus,
      );
      return {
        index: outputIndex,
        draftIndex: meta.draftIndex,
        sourceIndexes,
        before,
        after,
        changed: before !== after || structural,
        deleted: false,
        structureChanged: structural,
        diff: buildTimedTextDiff(before, after),
        mappingStatus,
        beforeItemCount: sourceSlice.items.length,
        afterItemCount: Array.isArray(output?.items) ? output.items.length : 0,
        preservedItems: Array.isArray(output?.items) ? output.items.length : 0,
        affectedItems: Array.isArray(output?.items) ? output.items.length : 0,
        items: output?.items,
        itemCoverage: coverage.percent,
        itemCoverageData: coverage,
        itemReuse: reuse.percent,
        itemReuseData: reuse,
        beforeStart: sourceSlice.items[0]?.start ?? Number(output?.start),
        beforeEnd: sourceSlice.items[sourceSlice.items.length - 1]?.end ?? Number(output?.end),
        afterStart: Number(output?.start),
        afterEnd: Number(output?.end),
        timingChanged: structural,
        timingEstimated: meta.timingEstimated === true,
      };
    });
    const rows = source.map((segment, index) => {
      const outputIndexes = plan.sourceOutputIndexes[index] || [];
      const outputs = outputIndexes.map((outputIndex) => plan.segments[outputIndex]).filter(Boolean);
      const before = String(segment?.text == null ? '' : segment.text);
      const after = outputs.map((output) => String(output?.text || '')).join('');
      const affected = plan.affectedSourceIndexes.includes(index);
      const diff = buildTimedTextDiff(before, after);
      const items = outputs.flatMap((output) => Array.isArray(output?.items) ? output.items : []);
      const mappingStatus = affected ? 'structure' : reconcileTimedTextItems(before, segment?.items, after).status;
      const coverage = timedTextItemCoverage(after, items);
      const reuse = timedTextItemReuse(
        before, segment?.items, after, items, mappingStatus,
      );
      const firstOutput = outputs[0];
      const lastOutput = outputs[outputs.length - 1];
      const afterStart = firstOutput ? Number(firstOutput.start) : Number(segment?.start);
      const afterEnd = lastOutput ? Number(lastOutput.end) : Number(segment?.end);
      return {
        index,
        before,
        after,
        displayAfter: outputs.map((output) => String(output?.text || '')).join('\n'),
        changed: before !== after || affected,
        deleted: Boolean(before.trim() && !after.trim()),
        structureChanged: affected,
        diff,
        mappingStatus,
        beforeItemCount: Array.isArray(segment?.items) ? segment.items.length : 0,
        afterItemCount: items.length,
        preservedItems: items.length,
        affectedItems: items.length,
        items,
        itemCoverage: coverage.percent,
        itemCoverageData: coverage,
        itemReuse: reuse.percent,
        itemReuseData: reuse,
        beforeStart: Number(segment?.start),
        beforeEnd: Number(segment?.end),
        afterStart,
        afterEnd,
        timingChanged: affected
          || afterStart !== Number(segment?.start) || afterEnd !== Number(segment?.end),
      };
    });
    const changedRows = rows.filter((row) => row.changed);
    const stats = {
      ...buildTimedTextEditReportFixed(source, source.map((segment) => segment?.text || '')).stats,
      totalSegments: source.length,
      changedSegments: changedRows.length,
      unchangedSegments: rows.length - changedRows.length,
      beforeCharacters: rows.reduce((sum, row) => sum + timedTextTokens(row.before).length, 0),
      afterCharacters: rows.reduce((sum, row) => sum + timedTextTokens(row.after).length, 0),
      addedCharacters: changedRows.reduce((sum, row) => sum + row.diff.addedCharacters, 0),
      removedCharacters: changedRows.reduce((sum, row) => sum + row.diff.removedCharacters, 0),
      fullMappedCues: changedRows.filter((row) => row.mappingStatus === 'full').length,
      partialMappedCues: changedRows.filter((row) => row.mappingStatus === 'partial').length,
      lostMappedCues: changedRows.filter((row) => row.mappingStatus === 'lost').length,
      unavailableMappedCues: changedRows.filter((row) => row.mappingStatus === 'unavailable').length,
      boundaryMappedCues: 0,
      boundaryMoves: 0,
      timingChangedCues: rows.filter((row) => row.timingChanged).length,
      preservedItems: changedRows.reduce((sum, row) => sum + row.preservedItems, 0),
      affectedItems: changedRows.reduce((sum, row) => sum + row.affectedItems, 0),
      structureMappedCues: changedRows.filter((row) => row.mappingStatus === 'structure').length,
      estimatedTimingCues: outputRows.filter((row) => row.timingEstimated).length,
    };
    return {
      valid: true,
      rows,
      changedRows,
      stats,
      boundaryMoves: [],
      structure: plan,
      previewSegments: plan.segments,
      outputRows,
    };
  }

  function buildTimedTextEditReport(segments, draftTexts) {
    const source = Array.isArray(segments) ? segments : [];
    const texts = Array.isArray(draftTexts) ? draftTexts : [];
    if (timedTextStructureRequested(source, texts)) {
      const plan = buildTimedTextStructurePlan(source, texts);
      if (plan.valid) return buildTimedTextStructureReport(source, texts, plan);
      return {
        ...buildTimedTextEditReportFixed(source, texts),
        structure: plan,
        previewSegments: [],
      };
    }
    return buildTimedTextEditReportFixed(source, texts);
  }

  function applyTimedTextEdit(segments, draftTexts) {
    const source = Array.isArray(segments) ? segments : [];
    const texts = Array.isArray(draftTexts) ? draftTexts : [];
    if (timedTextStructureRequested(source, texts)) {
      const structurePlan = buildTimedTextStructurePlan(source, texts);
      return structurePlan.valid ? cloneJsonValue(structurePlan.segments) : null;
    }
    if (source.length !== texts.length) return null;
    const boundaryPlan = buildTimedTextBoundaryPlan(source, texts);
    return source.flatMap((segment, index) => {
      const next = cloneJsonValue(segment || {});
      const before = String(next.text == null ? '' : next.text);
      const after = String(texts[index] == null ? '' : texts[index]);
      if (before === after) return next;
      if (!after) return [];
      const boundary = boundaryPlan.updates[index];
      if (boundary) {
        next.text = after;
        next.start = boundary.start;
        next.end = boundary.end;
        if (boundary.items.length) next.items = cloneJsonValue(boundary.items);
        else delete next.items;
        return next;
      }
      const mapping = reconcileTimedTextItems(before, next.items, after);
      next.text = after;
      if (mapping.status === 'full' || mapping.status === 'partial') next.items = mapping.items;
      else if (mapping.status === 'lost') delete next.items;
      return next;
    });
  }

  function countTextUnits(text) {
    const normalized = String(text || '').replace(/\r\n?/g, '').replace(/\n/g, '');
    let total = 0;
    for (const ch of normalized) total += ch.codePointAt(0) < 256 ? 0.5 : 1;
    return total;
  }

  function countSubtitleUnits(text, mode = null) {
    const normalized = String(text || '').replace(/\r\n?/g, '').replace(/\n/g, '').trim();
    if (!normalized) return 0;
    const resolvedMode = mode === 'continuous' || mode === 'word'
      ? mode : detectSubtitleSplitMode(normalized);
    if (resolvedMode === 'continuous') {
      const matches = normalized.match(/[\p{L}\p{N}]/gu);
      return matches ? matches.length : 0;
    }
    return normalized.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
  }

  function cueMetrics(text, start, end, mode = null) {
    const totalLength = mode === 'continuous' || mode === 'word'
      ? countSubtitleUnits(text, mode) : countTextUnits(text);
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
    return countSubtitleUnits(text);
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

  // 保存前只修复段内 item 的顺序和零时长，不改动字幕段本身的范围。
  // 这样可以自动处理波形取整造成的 1ms 字/词时间码重叠，同时把真正的
  // 字幕段重叠交给服务端严格校验。
  function normalizeItemTimingRanges(segments, minMs = 100) {
    const floor = Math.max(1, Math.round(Number(minMs) || 100));
    const source = Array.isArray(segments) ? segments : [];
    let fixed = 0;
    source.forEach((segment) => {
      if (!segment || typeof segment !== 'object') return;
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
    const activeIndex = segments.findIndex((segment, index) => (
      segment && Number(segment.start) <= time && (
        Number(segment.end) > time
        || index === segments.length - 1
        || Number(segments[index + 1]?.start) > time
      )
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

  const EDITOR_SETTING_ROW_HEIGHTS = [64, 80, 96, 120, 144, 168];
  const DEFAULT_EDITOR_SETTINGS = Object.freeze({
    splitKey: 'enter', splitUseWordTimestamps: true, splitAutoSubmit: true,
    overlayEnabled: true, extensionOverlayEnabled: true, multiSubtitleRowHeight: 168,
    exportStartAtZero: false, cueListShowIndex: true, cueListShowTime: true,
    cueListShowSticker: true, cueListShowCharcount: true, cueListAutoScrollOnClick: true,
    cueListKeepSplitVisible: true, cueListHideDisabled: false, cueListCharcountThreshold: 16,
    cueEditorShowNavigation: false, cueEditorShowTimeActions: false, cueEditorShowSticker: false,
    cueEditorCancelOnEscape: false, selectGroupMembers: false, mergeJoinText: '',
    autoMergeGapMs: 200, autoMergeSnapDirection: 'backward', autoMergeShortCount: 3,
    autoMergeAbsorbShort: true, autoMergeAbsorbDirection: 'previous', exportColorUnified: true,
    autoSaveProject: true, autoSaveIntervalSeconds: 30, stickerOverlayEnabled: false,
    stickerOtioExportMode: 'original', clickBehavior: 'select-and-seek', clickTarget: 'pointer',
    keyboardOperationReference: 'pointer', jklPlaybackMode: 'direction', mediaSeekStepMs: 1000,
    cueMoveStepMs: 50, hoverSeekPreview: false, autoSnapAdjacentCues: true, ninjaMode: false,
    ninjaSound: true, ninjaSlashEffect: true, ninjaSlashLengthPercent: 80,
    ninjaSlashRotateAmplitude: 6, crossTrackSnap: true, selectBoundSubtitlePair: true,
    multiSubtitleAutoSyncDuration: true, multiSubtitleShowTrackBadges: false, theme: 'dark',
    waveShapeSource: 'self',
  });

  function clampInteger(value, fallback, minimum, maximum) {
    const rounded = Math.round(Number(value));
    return Math.min(maximum, Math.max(minimum, Number.isFinite(rounded) ? rounded : fallback));
  }

  function normalizeEditorSettings(saved = {}) {
    const savedSettings = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
    const legacySeekStepSeconds = Number(savedSettings.mediaSeekStepSeconds);
    const mediaSeekStepMs = savedSettings.mediaSeekStepMs !== undefined
      ? savedSettings.mediaSeekStepMs
      : Number.isFinite(legacySeekStepSeconds) ? legacySeekStepSeconds * 1000 : undefined;
    return {
      ...DEFAULT_EDITOR_SETTINGS,
      splitKey: savedSettings.splitKey === 'ctrl-enter' ? 'ctrl-enter' : 'enter',
      splitUseWordTimestamps: savedSettings.splitUseWordTimestamps !== false,
      splitAutoSubmit: savedSettings.splitAutoSubmit !== false,
      overlayEnabled: savedSettings.overlayEnabled !== false,
      extensionOverlayEnabled: savedSettings.extensionOverlayEnabled !== false,
      multiSubtitleRowHeight: EDITOR_SETTING_ROW_HEIGHTS.includes(Number(savedSettings.multiSubtitleRowHeight))
        ? Number(savedSettings.multiSubtitleRowHeight) : 168,
      exportStartAtZero: savedSettings.exportStartAtZero === true,
      cueListShowIndex: savedSettings.cueListShowIndex !== false,
      cueListShowTime: savedSettings.cueListShowTime !== false,
      cueListShowSticker: savedSettings.cueListShowSticker !== false,
      cueListShowCharcount: savedSettings.cueListShowCharcount !== false,
      cueListAutoScrollOnClick: savedSettings.cueListAutoScrollOnClick !== false,
      cueListKeepSplitVisible: savedSettings.cueListKeepSplitVisible !== false,
      cueListHideDisabled: savedSettings.cueListHideDisabled === true,
      cueListCharcountThreshold: clampInteger(savedSettings.cueListCharcountThreshold, 16, 1, 200),
      cueEditorShowNavigation: savedSettings.cueEditorShowNavigation === true,
      cueEditorShowTimeActions: savedSettings.cueEditorShowTimeActions === true,
      cueEditorShowSticker: savedSettings.cueEditorShowSticker === true,
      cueEditorCancelOnEscape: savedSettings.cueEditorCancelOnEscape === true,
      selectGroupMembers: savedSettings.selectGroupMembers === true,
      mergeJoinText: typeof savedSettings.mergeJoinText === 'string' ? savedSettings.mergeJoinText : '',
      autoMergeGapMs: clampInteger(savedSettings.autoMergeGapMs, 200, 0, 10000),
      autoMergeSnapDirection: savedSettings.autoMergeSnapDirection === 'forward' ? 'forward' : 'backward',
      autoMergeShortCount: clampInteger(savedSettings.autoMergeShortCount, 3, 1, 20),
      autoMergeAbsorbShort: savedSettings.autoMergeAbsorbShort !== false,
      autoMergeAbsorbDirection: savedSettings.autoMergeAbsorbDirection === 'next' ? 'next' : 'previous',
      exportColorUnified: savedSettings.exportColorUnified !== false,
      autoSaveProject: savedSettings.autoSaveProject !== false,
      autoSaveIntervalSeconds: clampInteger(savedSettings.autoSaveIntervalSeconds, 30, 5, 3600),
      stickerOverlayEnabled: savedSettings.stickerOverlayEnabled === true,
      stickerOtioExportMode: savedSettings.stickerOtioExportMode === 'portable' ? 'portable' : 'original',
      clickBehavior: ['select-only', 'select-and-seek', 'select-and-play'].includes(savedSettings.clickBehavior)
        ? savedSettings.clickBehavior : 'select-and-seek',
      clickTarget: ['cue-start', 'pointer'].includes(savedSettings.clickTarget) ? savedSettings.clickTarget : 'pointer',
      keyboardOperationReference: savedSettings.keyboardOperationReference === 'playhead' ? 'playhead' : 'pointer',
      jklPlaybackMode: ['speed', 'direction'].includes(savedSettings.jklPlaybackMode)
        ? savedSettings.jklPlaybackMode : 'direction',
      mediaSeekStepMs: clampInteger(mediaSeekStepMs, 1000, 10, 60000),
      cueMoveStepMs: clampInteger(savedSettings.cueMoveStepMs, 50, 10, 2000),
      hoverSeekPreview: savedSettings.hoverSeekPreview === true,
      autoSnapAdjacentCues: savedSettings.autoSnapAdjacentCues !== false,
      ninjaMode: savedSettings.ninjaMode === true,
      ninjaSound: savedSettings.ninjaSound !== false,
      ninjaSlashEffect: savedSettings.ninjaSlashEffect !== false,
      ninjaSlashLengthPercent: clampInteger(savedSettings.ninjaSlashLengthPercent, 80, 20, 400),
      ninjaSlashRotateAmplitude: clampInteger(savedSettings.ninjaSlashRotateAmplitude, 6, 0, 60),
      crossTrackSnap: savedSettings.crossTrackSnap !== false,
      selectBoundSubtitlePair: savedSettings.selectBoundSubtitlePair !== false,
      multiSubtitleAutoSyncDuration: savedSettings.multiSubtitleAutoSyncDuration !== false,
      multiSubtitleShowTrackBadges: savedSettings.multiSubtitleShowTrackBadges === true,
      theme: savedSettings.theme === 'light' ? 'light' : 'dark',
      waveShapeSource: savedSettings.waveShapeSource === 'reapeaks' ? 'reapeaks' : 'self',
    };
  }

  function normalizeMultiSubtitleRowHeight(value) {
    return EDITOR_SETTING_ROW_HEIGHTS.includes(Number(value)) ? Number(value) : 168;
  }
  function normalizeClickBehavior(value) {
    return ['select-only', 'select-and-seek', 'select-and-play'].includes(value)
      ? value : 'select-and-seek';
  }
  function normalizeClickTarget(value) {
    return ['cue-start', 'pointer'].includes(value) ? value : 'pointer';
  }
  function normalizeKeyboardOperationReferenceMode(value) {
    return value === 'playhead' ? 'playhead' : 'pointer';
  }
  function normalizeJklPlaybackMode(value) {
    return ['speed', 'direction'].includes(value) ? value : 'direction';
  }
  function clampMediaSeekStepMs(value) { return clampInteger(value, 1000, 10, 60000); }
  function clampCueMoveStepMs(value) { return clampInteger(value, 50, 10, 2000); }
  function clampAutoSaveInterval(value) { return clampInteger(value, 30, 5, 3600); }
  function clampCharcountThreshold(value) { return clampInteger(value, 16, 1, 200); }
  function clampNinjaSlashLength(value) { return clampInteger(value, 80, 20, 400); }
  function clampNinjaSlashRotateAmplitude(value) { return clampInteger(value, 6, 0, 60); }
  function clampAutoMergeGapMs(value) { return clampInteger(value, 200, 0, 10000); }
  function clampAutoMergeShortCount(value) { return clampInteger(value, 3, 1, 20); }

  const GAP_REMOVE_SCHEMA = 'moy.asr.gap_remove.v1';
  function normalizeGapRemoveData(value) {
    const source = value && typeof value === 'object' ? value : {};
    const gaps = cloneJsonValue(normalizeGapRemoveGaps(source.gaps)) || [];
    return {
      schema: GAP_REMOVE_SCHEMA,
      detector: source.detector === 'audio_gate' || !gaps.length ? 'audio_gate' : 'legacy_subtitle_gap',
      minimum_ms: clampInteger(source.minimum_ms, 500, 100, 60000),
      threshold_db: Math.min(0, Math.max(-96, Number.isFinite(Number(source.threshold_db)) ? Number(source.threshold_db) : -24)),
      hysteresis_db: Math.min(30, Math.max(0, Number.isFinite(Number(source.hysteresis_db)) ? Number(source.hysteresis_db) : 2)),
      lead_in_ms: clampInteger(source.lead_in_ms, 40, 0, 2000),
      lead_out_ms: clampInteger(source.lead_out_ms, 80, 0, 2000),
      skip_playback: source.skip_playback !== false,
      manual_corrections: source.manual_corrections === true,
      operation_mode: ['none', 'boundary_drag', 'middle_drag'].includes(source.operation_mode)
        ? source.operation_mode : 'boundary_drag',
      gaps,
    };
  }

  const HISTORY_RECORD_DEFAULT_LABELS = Object.freeze({
    segments: '编辑', layout: '调整工作区', gap_remove: '空隙移除', preview: '预览',
  });
  function buildSegmentsHistorySnapshot(segments, multiSubtitle) {
    return { segments: cloneJsonValue(segments), multi_subtitle: cloneJsonValue(multiSubtitle) };
  }
  function buildHistoryRecord(kind, label, payload, view = null) {
    const recordKind = Object.prototype.hasOwnProperty.call(HISTORY_RECORD_DEFAULT_LABELS, kind)
      ? kind : 'segments';
    const record = { kind: recordKind, label: label || HISTORY_RECORD_DEFAULT_LABELS[recordKind] };
    if (recordKind === 'segments') {
      record.segs = cloneJsonValue(payload);
      if (view) record.view = cloneJsonValue(view);
    } else if (recordKind === 'layout') record.layout = payload || null;
    else if (recordKind === 'gap_remove') {
      record.gapRemove = cloneJsonValue(payload?.gapRemove ?? null);
      record.gapRemoveDirty = payload?.gapRemoveDirty === true;
    } else record.preview = cloneJsonValue(payload);
    return record;
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
    // Reserve every valid explicit ID first. This keeps the browser's repair
    // result identical to maw.project._normalize_stable_ids when a generated
    // ID would otherwise collide with a later explicit one.
    const reserved = new Set(source
      .map((segment) => stableId(segment?.id))
      .filter(Boolean));
    const used = new Set();
    let changed = 0;
    source.forEach((segment, index) => {
      if (!segment || typeof segment !== 'object') return;
      let id = stableId(segment.id);
      if (!id || used.has(id)) {
        const base = `${prefix}-${String(index + 1).padStart(3, '0')}`;
        id = base;
        let suffix = 2;
        while (used.has(id) || (id !== base && reserved.has(id))) {
          id = `${base}-${suffix++}`;
        }
        if (reserved.has(id)) {
          id = `${base}-generated`;
          suffix = 2;
          while (used.has(id) || reserved.has(id)) {
            id = `${base}-generated-${suffix++}`;
          }
        }
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
          // Extension SRT has no items, while an imported mosp/project or a
          // swapped-down main track may carry optional word timestamps. Keep
          // them when present so a later swap can restore the main track.
          if (Array.isArray(copy.items)) {
            copy.items = copy.items.map((item) => ({ ...item }));
          } else {
            delete copy.items;
          }
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
      main_split_mode: MULTI_SUBTITLE_SPLIT_MODES.has(source.main_split_mode)
        ? source.main_split_mode
        : detectSubtitleSplitMode((Array.isArray(mainSegments) ? mainSegments : [])
          .map((segment) => segment?.text || '').join('\n')),
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

  // 单词型字幕允许在连接两个词的符号处拆分，例如「the story—you」或「state-of-the-art」。
  // 不包含撇号和句点，避免把 contraction、小数或缩写误判成单词边界。
  const WORD_SPLIT_CONNECTOR_RE = /^[\p{Pd}\p{Pc}\p{Sm}.,!?;:，。！？；：、…\/／\\&|｜~～·•⋅]+$/u;
  const WORD_SPLIT_CONTENT_RE = /[\p{L}\p{N}]/u;

  function isWordSplitConnector(character) {
    return WORD_SPLIT_CONNECTOR_RE.test(String(character || ''));
  }

  function isWordSplitContent(character) {
    return WORD_SPLIT_CONTENT_RE.test(String(character || ''));
  }

  function isLikelyAbbreviationPeriod(characters, index, runEnd) {
    if (runEnd !== index || characters[index] !== '.') return false;
    const left = characters[index - 1] || '';
    const right = characters[runEnd + 1] || '';
    if (/\d/u.test(left) && /\d/u.test(right)) return true;
    const previousPrevious = characters[index - 2] || '';
    const leftIsSingleLetter = isWordSplitContent(left)
      && !isWordSplitContent(previousPrevious);
    const rightIsSingleLetter = isWordSplitContent(right)
      && !isWordSplitContent(characters[runEnd + 2] || '');
    return leftIsSingleLetter && rightIsSingleLetter;
  }

  function isWordSplitConnectorBoundary(text, offset) {
    const value = String(text || '');
    const left = Array.from(value.slice(0, offset));
    const right = Array.from(value.slice(offset));
    return isWordSplitConnector(left[left.length - 1]) || isWordSplitConnector(right[0]);
  }

  function subtitleSplitOffsets(text, mode = 'word') {
    const value = String(text || '');
    const offsets = [];
    const characters = Array.from(value);
    const isValidOffset = (candidate) => {
      const preserveWordConnector = mode === 'word'
        && isWordSplitConnectorBoundary(value, candidate);
      const parts = cleanSplitTextParts(value, candidate, preserveWordConnector);
      return Boolean(parts.left && parts.right);
    };
    if (mode === 'continuous') {
      let offset = 0;
      for (let index = 0; index < characters.length - 1; index++) {
        offset += characters[index].length;
        // 把连续空白当作一个可替换的断点：跳过空白前的候选，
        // 保留空白后的候选，这样「A  B」只显示一个「✂️」。
        if (/\s/u.test(characters[index + 1])) continue;
        offsets.push(offset);
      }
      return offsets.filter(isValidOffset);
    }

    // 单词型在空格组之后，或连接两个词的符号两侧提供断点。
    // 句号只在后侧提供断点：「quickly.✂️And」；连字符仍可两侧断开。
    let offset = 0;
    for (let index = 0; index < characters.length; index++) {
      if (/\s/u.test(characters[index])) {
        while (index + 1 < characters.length && /\s/u.test(characters[index + 1])) {
          index += 1;
          offset += characters[index].length;
        }
        offset += characters[index].length;
        if (offset > 0 && offset < value.length
            && value.slice(0, offset).trim() && value.slice(offset).trim()) {
          offsets.push(offset);
        }
        continue;
      }
      if (isWordSplitConnector(characters[index])) {
        let runEnd = index;
        let runOffset = offset + characters[index].length;
        while (runEnd + 1 < characters.length
            && isWordSplitConnector(characters[runEnd + 1])) {
          runEnd += 1;
          runOffset += characters[runEnd].length;
        }
        const connectsWords = index > 0
          && runEnd + 1 < characters.length
          && isWordSplitContent(characters[index - 1])
          && isWordSplitContent(characters[runEnd + 1]);
        if (connectsWords && !isLikelyAbbreviationPeriod(characters, index, runEnd)) {
          if (characters[index] !== '.') offsets.push(offset);
          offsets.push(runOffset);
        }
        offset = runOffset;
        index = runEnd;
        continue;
      }
      offset += characters[index].length;
    }
    return [...new Set(offsets)].filter(isValidOffset);
  }

  function cleanSplitTextParts(text, offset, preserveWordConnector = false) {
    const value = String(text || '');
    const safeOffset = Math.max(0, Math.min(value.length, Math.round(Number(offset) || 0)));
    const trimPattern = preserveWordConnector ? /\s+$/u : /[，。,.!?！？；;：:\s]+$/u;
    const trimStartPattern = preserveWordConnector ? /^\s+/u : /^[，。,.!?！？；;：:\s]+/u;
    const left = value.slice(0, safeOffset).replace(trimPattern, '');
    const right = value.slice(safeOffset).replace(trimStartPattern, '');
    return { left, right, offset: safeOffset };
  }

  function splitSubtitleText(text, offset, mode = 'word') {
    const value = String(text || '');
    const safeOffset = Math.max(0, Math.min(value.length, Math.round(Number(offset) || 0)));
    const offsets = subtitleSplitOffsets(value, mode);
    if (!offsets.includes(safeOffset)) return null;
    const preserveWordConnector = mode === 'word'
      && isWordSplitConnectorBoundary(value, safeOffset);
    const parts = cleanSplitTextParts(value, safeOffset, preserveWordConnector);
    if (!parts.left || !parts.right) return null;
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

  // 交换主轨与当前唯一扩展轨。扩展轨保留可选的 items，
  // 但不携带表情包和颜色分组等主轨专属字段。
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
    const oldMainSplitMode = multi.main_split_mode;
    const oldExtensionSplitMode = track.split_mode;
    const nextMain = oldExtension.map((segment) => ({ ...segment }));
    const nextExtension = oldMain.map((segment) => {
      const copy = {
        id: stableId(segment.id),
        start: segment.start,
        end: segment.end,
        text: typeof segment.text === 'string' ? segment.text : '',
      };
      if (Array.isArray(segment.items)) {
        copy.items = segment.items.map((item) => ({ ...item }));
      }
      if (segment._dirty) copy._dirty = true;
      return copy;
    });

    project.segments.length = 0;
    nextMain.forEach((segment) => project.segments.push(segment));
    track.segments = nextExtension;
    multi.main_split_mode = oldExtensionSplitMode;
    track.split_mode = oldMainSplitMode;

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
    const keepDisabledPlaceholder = options.keepDisabledPlaceholder === true && !colorName;
    const parts = [];
    let outputIndex = 0;
    source.forEach((segment, sourceIndex) => {
      if (!segment) return;
      const disabled = segment.disabled === true;
      if (disabled && !keepDisabledPlaceholder) return;
      if (!disabled && colorName) {
        const effectiveName = effectiveColorName(segment, source);
        const matches = colorName === 'default' ? !effectiveName : effectiveName === colorName;
        if (!matches) return;
      }
      const mappedStart = Math.max(0, Math.round(Number(mapTime(segment.start)) || 0));
      const start = alignFirstStart && !disabled && sourceIndex === firstEnabledIndex ? 0 : mappedStart;
      const mappedEnd = Math.max(0, Math.round(Number(mapTime(segment.end)) || 0));
      const end = options.ensurePositiveDuration ? Math.max(start + 1, mappedEnd) : mappedEnd;
      outputIndex += 1;
      parts.push(String(outputIndex));
      parts.push(`${formatTime(start)} --> ${formatTime(end)}`);
      parts.push(disabled ? '' : String(segment.text || ''));
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

  const EXPORT_FRAME_PROFILES = Object.freeze({
    24: Object.freeze({ name: '24', numerator: 24, denominator: 1, fps: 24 }),
    25: Object.freeze({ name: '25', numerator: 25, denominator: 1, fps: 25 }),
    30: Object.freeze({ name: '30', numerator: 30, denominator: 1, fps: 30 }),
    '30000/1001': Object.freeze({ name: '30000/1001', numerator: 30000, denominator: 1001, fps: 30000 / 1001 }),
    50: Object.freeze({ name: '50', numerator: 50, denominator: 1, fps: 50 }),
    60: Object.freeze({ name: '60', numerator: 60, denominator: 1, fps: 60 }),
    '60000/1001': Object.freeze({ name: '60000/1001', numerator: 60000, denominator: 1001, fps: 60000 / 1001 }),
  });

  function resolveExportFrameProfile(fps, dropFrame = false) {
    if (typeof dropFrame !== 'boolean') throw new Error('drop-frame option must be boolean');
    const key = String(fps);
    const profile = EXPORT_FRAME_PROFILES[key];
    if (!profile) throw new Error(`unsupported export FPS: ${key}`);
    if (dropFrame) throw new Error(`drop-frame export is unsupported for ${key}`);
    return profile;
  }

  function exportMsToFrames(ms, fps, rounding = 'floor') {
    const profile = typeof fps === 'object' && fps?.numerator
      ? fps : resolveExportFrameProfile(fps, false);
    const value = Math.max(0, Number(ms)) * profile.numerator / (1000 * profile.denominator);
    if (!Number.isFinite(value)) throw new Error('invalid export time');
    if (rounding === 'ceil') return Math.max(1, Math.ceil(value));
    if (rounding !== 'floor') throw new Error(`unsupported frame rounding: ${rounding}`);
    return Math.max(0, Math.floor(value));
  }

  function mapExportTime(policy, sourceMs) {
    const source = Math.max(0, Math.round(Number(sourceMs) || 0));
    const mapped = policy.mode === 'source' ? source : mapGapRemovedTime(source, policy.gaps);
    return Math.min(policy.outputDurationMs ?? policy.sourceDurationMs, mapped);
  }

  function exportPolicyMsToFrames(policy, ms, rounding = 'floor') {
    return exportMsToFrames(ms, policy.profile, rounding);
  }

  const EXPORT_SUBTITLE_TRACKS = Object.freeze(['main', 'extension', 'both', 'main_and_extension']);
  const EXPORT_INVALID_NAME_CHARS = /[\\/<>:"|?*\u0000-\u001f]/g;
  const EXPORT_OPTION_KEYS = Object.freeze([
    'timelineMode', 'mode', 'fps', 'dropFrame', 'nativeTextObjects', 'subtitleTracks', 'baseName',
  ]);

  function normalizeExportOptions(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new Error('export options must be an object');
    }
    Object.keys(options).sort().forEach((key) => {
      if (!EXPORT_OPTION_KEYS.includes(key)) throw new Error(`unknown export option: ${key}`);
    });
    const timelineMode = options.timelineMode ?? options.mode ?? 'gap_removed';
    if (timelineMode !== 'source' && timelineMode !== 'gap_removed') {
      throw new Error(`unsupported export mode: ${timelineMode}`);
    }
    const fps = String(options.fps ?? 30);
    resolveExportFrameProfile(fps, options.dropFrame === true);
    if (options.dropFrame !== undefined && typeof options.dropFrame !== 'boolean') {
      throw new Error('drop-frame option must be boolean');
    }
    const subtitleTracks = options.subtitleTracks ?? 'main';
    if (!EXPORT_SUBTITLE_TRACKS.includes(subtitleTracks)) {
      throw new Error(`unsupported subtitle tracks: ${subtitleTracks}`);
    }
    const nativeTextObjects = options.nativeTextObjects ?? false;
    if (typeof nativeTextObjects !== 'boolean') throw new Error('native text option must be boolean');
    const dropFrame = options.dropFrame ?? false;
    const baseName = String(options.baseName ?? 'maw-export').trim();
    if (!baseName || baseName === '.' || baseName === '..' || /[\u0000-\u001f]/.test(baseName)) {
      throw new Error('invalid export base name');
    }
    return Object.freeze({
      timelineMode, fps, dropFrame, nativeTextObjects,
      subtitleTracks: subtitleTracks === 'both' ? 'main_and_extension' : subtitleTracks, baseName,
    });
  }

  function sanitizeExportName(value) {
    const sanitized = String(value ?? '')
      .replace(/\.[^.]+$/, '')
      .replace(/[\\/]+/g, '_')
      .replace(/^[.]+/, '_')
      .replace(/\.\.(?=_|$)/g, '_')
      .replace(EXPORT_INVALID_NAME_CHARS, '_')
      .replace(/[. ]+$/, '')
      .trim();
    if (!sanitized || sanitized === '.' || sanitized === '..') throw new Error('invalid export base name');
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(sanitized)) return `_${sanitized}_`;
    return sanitized;
  }

  function buildExportNames(baseName) {
    const safeBaseName = sanitizeExportName(baseName);
    return Object.freeze({
      baseName: safeBaseName,
      files: Object.freeze({
        project: `${safeBaseName}.xml`,
        subtitles: `${safeBaseName}.srt`,
      }),
    });
  }

  function escapeExportXml(value) {
    const text = String(value ?? '');
    for (const character of text) {
      const codePoint = character.codePointAt(0);
      if (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d) {
        throw new Error('XML 1.0 forbidden control character');
      }
    }
    return text.replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
    }[character]));
  }

  function exportPathToFileUrl(value, { encodeDriveColon = false } = {}) {
    const source = String(value ?? '').trim();
    if (!source) throw new Error('missing export path');
    if (/^file:\/\//i.test(source)) {
      const match = /^file:\/\/([^/]*)(\/.*)?$/i.exec(source);
      if (!match) throw new Error('invalid file URL');
      const authority = match[1];
      const pathValue = match[2] || '';
      const driveUrlMatch = /^\/([A-Za-z]):\/(.*)$/.exec(pathValue);
      if (authority.toLowerCase() === 'localhost' && driveUrlMatch) {
        const encodedPath = driveUrlMatch[2].split('/').map((part) => encodeURIComponent(part)).join('/');
        const drive = encodeDriveColon ? `${driveUrlMatch[1]}%3A` : `${driveUrlMatch[1]}:`;
        return `file://localhost/${drive}/${encodedPath}`;
      }
      if (!authority && driveUrlMatch) {
        const encodedDrivePath = driveUrlMatch[2].split('/').map((part) => encodeURIComponent(part)).join('/');
        return `file://localhost/${driveUrlMatch[1]}:/${encodedDrivePath}`;
      }
      if (authority && !pathValue || authority && !/^\/[^/]+(?:\/|$)/.test(pathValue)) {
        throw new Error('UNC file URL must include a share');
      }
      const encodedPath = pathValue.split('/').map((part) => encodeURIComponent(part)).join('/');
      return `file://${authority}${encodedPath}`;
    }
    const normalized = source.replace(/\\/g, '/');
    const uncMatch = /^\/\/([^/]+)(\/.*)?$/.exec(normalized);
    if (uncMatch) {
      const uncPath = uncMatch[2] || '';
      if (!/^\/[^/]+(?:\/|$)/.test(uncPath)) throw new Error('UNC path must include a share');
      const encodedUncPath = uncPath.split('/').map((part) => encodeURIComponent(part)).join('/');
      return `file://${uncMatch[1]}${encodedUncPath}`;
    }
    const driveMatch = /^([A-Za-z]):\/(.*)$/.exec(normalized);
    if (driveMatch) {
      const encodedDriveParts = driveMatch[2].split('/').map((part) => encodeURIComponent(part)).join('/');
      const drive = encodeDriveColon ? `${driveMatch[1]}%3A` : `${driveMatch[1]}:`;
      return `file://localhost/${drive}/${encodedDriveParts}`;
    }
    const withLeadingSlash = normalized;
    const rooted = withLeadingSlash.startsWith('/') ? withLeadingSlash : `/${withLeadingSlash}`;
    const encoded = rooted.split('/').map((part, index) => (
      index === 0 && part === '' ? '' : encodeURIComponent(part).replace(/^([A-Za-z])%3A$/, '$1:')
    )).join('/');
    return `file://${encoded}`;
  }

  function freezeExportValue(value, seen = new Set()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return value;
    seen.add(value);
    Object.values(value).forEach((child) => freezeExportValue(child, seen));
    return Object.freeze(value);
  }

  function buildProjectExportPlan(project, options = {}) {
    if (!project || typeof project !== 'object') throw new Error('invalid export project');
    const media = project.media && typeof project.media === 'object' ? project.media : null;
    const mediaPath = String((typeof project.media === 'string' ? project.media : '')
      || media?.path || media?.mediaPath || '').trim();
    const durationValue = options.durationMs ?? project.waveform?.duration_ms ?? project.duration_ms
      ?? media?.durationMs ?? media?.duration_ms;
    const durationMs = durationValue;
    if (!mediaPath) throw new Error('missing export media path');
    if (!Number.isInteger(durationMs) || durationMs <= 0) throw new Error('missing export media duration');
    const requestedMode = options.timelineMode ?? options.mode ?? 'gap_removed';
    if (requestedMode !== 'source' && requestedMode !== 'gap_removed') {
      throw new Error(`unsupported export mode: ${requestedMode}`);
    }
    const mode = requestedMode;
    if (options.dropFrame !== undefined && typeof options.dropFrame !== 'boolean') {
      throw new Error('drop-frame option must be boolean');
    }
    const rawGaps = project.gaps !== undefined ? project.gaps : project.gap_remove?.gaps;
    if (rawGaps != null && !Array.isArray(rawGaps)) throw new Error('invalid export gaps');
    const malformedGap = (gap) => {
      const start = gap?.start;
      const end = gap?.end;
      return !Number.isInteger(start) || start < 0
        || !Number.isInteger(end) || end < 0 || end <= start;
    };
    if (Array.isArray(rawGaps) && rawGaps.some(malformedGap)) {
      throw new Error('invalid export gap interval');
    }
    const gaps = Array.isArray(rawGaps)
      ? rawGaps.map((gap) => ({
        start: Math.max(0, Math.round(Number(gap.start))),
        end: Math.max(0, Math.round(Number(gap.end))),
        removed: gap.removed !== false,
      }))
      : [];
    const keptIntervals = mode === 'source'
      ? [{ start: 0, end: durationMs }]
      : buildGapRemovedIntervals(durationMs, gaps);
    const outputDurationMs = keptIntervals.reduce((sum, interval) => sum + interval.end - interval.start, 0);
    if (outputDurationMs <= 0) throw new Error('export has no kept media');
    const frameProfile = resolveExportFrameProfile(options.fps ?? 30, options.dropFrame === true);
    const mapSourceToOutput = (sourceMs) => mode === 'source'
      ? Math.max(0, Math.min(durationMs, Math.round(Number(sourceMs) || 0)))
      : mapGapRemovedTime(sourceMs, gaps);
    const warnings = [];
    if (mode === 'gap_removed' && !gaps.some((gap) => gap.removed)) warnings.push({ code: 'no_removed_gaps' });
    const projectSegments = Array.isArray(project.segments) ? project.segments : [];
    const schemaExtension = Array.isArray(project.multi_subtitle?.tracks)
      ? project.multi_subtitle.tracks.flatMap((track) => Array.isArray(track?.segments) ? track.segments : [])
      : [];
    const projectExtension = project.multi_subtitle?.enabled === true
      ? schemaExtension
      : (project.multi_subtitle == null && Array.isArray(project.extensionSegments)
        ? project.extensionSegments : []);
    const projectCues = (segments, track) => segments.map((segment, index) => {
      if (!segment || segment.disabled) return null;
      const rawStart = Math.round(Number(segment.start));
      const rawEnd = Math.round(Number(segment.end));
      const start = Math.min(durationMs, Math.max(0, rawStart));
      const end = Math.min(durationMs, Math.max(start, rawEnd));
      if (!Number.isInteger(segment?.start) || segment.start < 0
        || !Number.isInteger(segment?.end) || segment.end < 0 || segment.end <= segment.start) {
        warnings.push({ code: 'invalid_cue', track, index });
        return null;
      }
      const mappedStart = mapSourceToOutput(start);
      const mappedEnd = mapSourceToOutput(end);
      if (mappedEnd <= mappedStart) {
        warnings.push({ code: 'fully_removed_cue', track, index });
        return null;
      }
      if (rawStart !== start || rawEnd !== end) warnings.push({ code: 'clamped_cue_to_duration', track, index });
      return {
        id: String(segment.id || `${track}-${index}`), track, index,
        text: String(segment.text || ''), sourceStartMs: start, sourceEndMs: end,
        startMs: mappedStart, endMs: mappedEnd,
      };
    }).filter(Boolean);
    const cues = { main: projectCues(projectSegments, 'main'), extension: projectCues(projectExtension, 'extension') };
    const stickers = [];
    const stickerHeads = new Set();
    const stickerRoot = String(project.sticker_root || project.stickerRoot || '').trim().replace(/[\\/]$/, '');
    const resolveStickerPath = (sticker) => {
      const rawPath = String(sticker?.rel || sticker?.filename || sticker?.path || sticker?.url || '').trim();
      if (!rawPath || !stickerRoot || /^[A-Za-z]:[\\/]/.test(rawPath)
        || rawPath.startsWith('/') || rawPath.startsWith('file://')) return rawPath;
      return `${stickerRoot}/${rawPath.replace(/^[\\/]+/, '')}`;
    };
    projectSegments.forEach((segment, index) => {
      const reference = segment?.sticker_ref;
      const source = segment?.sticker || (reference && projectSegments[reference.headIdx]?.sticker);
      if (reference && Number.isInteger(reference.headIdx)) {
        const head = projectSegments[reference.headIdx];
        if (!head?.sticker || head.disabled || reference.headIdx === index) {
          warnings.push({ code: 'dangling_sticker_reference', index, headIdx: reference.headIdx });
          return;
        } else {
          const headName = String(head.sticker.name || head.sticker.filename || '').replace(/\.[^.]+$/, '');
          if (reference.name && headName && reference.name !== headName) {
            warnings.push({ code: 'stale_sticker_reference', index, headIdx: reference.headIdx });
          }
        }
      }
      if (!source || segment.disabled || (segment.sticker && stickerHeads.has(index))) return;
      if (segment.sticker) stickerHeads.add(index);
      const timing = segment.sticker || segment;
      const stickerStart = Number(timing.start);
      const stickerEnd = Number(timing.end);
      const rawStart = Math.round(Number.isFinite(stickerStart) ? stickerStart : Number(segment.start) || 0);
      const rawEnd = Math.round(Number.isFinite(stickerEnd) ? stickerEnd : Number(segment.end) || 0);
      const start = Math.min(durationMs, Math.max(0, rawStart));
      const end = Math.min(durationMs, Math.max(start, rawEnd));
      if (end <= start || mapSourceToOutput(end) <= mapSourceToOutput(start)) {
        warnings.push({ code: 'fully_removed_sticker', index });
        return;
      }
      const resolvedStickerPath = resolveStickerPath(source);
      if (!resolvedStickerPath) {
        warnings.push({ code: 'missing_sticker_path', index });
        return;
      }
      if (rawStart !== start || rawEnd !== end) warnings.push({ code: 'clamped_sticker_to_duration', index });
      stickers.push({
        headIndex: index, name: String(source.name || ''),
        path: resolvedStickerPath, width: Number.isInteger(source.width) ? source.width : 720,
        height: Number.isInteger(source.height) ? source.height : 480,
        sourceStartMs: start, sourceEndMs: end,
        startMs: mapSourceToOutput(start), endMs: mapSourceToOutput(end),
      });
    });
    if (cues.main.length === 0 && cues.extension.length === 0) warnings.push({ code: 'no_enabled_cues' });
    warnings.sort((left, right) => left.code.localeCompare(right.code) || (left.index ?? 0) - (right.index ?? 0));
    const plan = {
      media: { path: mediaPath, type: String(media?.type || 'video'), durationMs },
      mode, sourceDurationMs: durationMs, keptIntervals, outputDurationMs,
      mapping: { mode, sourceDurationMs: durationMs, outputDurationMs, gaps },
      framePolicy: { profile: frameProfile, rounding: ['floor', 'ceil'], dropFrame: false },
      cues, stickers, warnings, frameProfile,
      subtitleFontFamily: premiereFontFamily(project.preview?.subtitle?.font_family),
    };
    Object.defineProperties(plan, {
      mapSourceToOutput: { value: (sourceMs) => mapExportTime(plan.mapping, sourceMs), enumerable: false },
      frameForMs: { value: (ms, rounding = 'floor') => exportMsToFrames(ms, frameProfile, rounding), enumerable: false },
    });
    return freezeExportValue(plan);
  }

  function assertExportPlan(plan) {
    if (!plan || typeof plan !== 'object') throw new Error('invalid export plan');
    if (!plan.media || !String(plan.media.path || '').trim()) throw new Error('missing export media path');
    if (!Number.isInteger(plan.sourceDurationMs) || plan.sourceDurationMs <= 0) {
      throw new Error('missing export media duration');
    }
    if (!plan.frameProfile || !Number.isInteger(plan.frameProfile.numerator)
      || !Number.isInteger(plan.frameProfile.denominator)) {
      throw new Error('missing export frame profile');
    }
    if (!Number.isInteger(plan.outputDurationMs) || plan.outputDurationMs <= 0) {
      throw new Error('invalid export plan duration');
    }
    if (!Array.isArray(plan.keptIntervals) || !plan.keptIntervals.length
      || plan.keptIntervals.some((interval) => !Number.isInteger(interval?.start)
        || !Number.isInteger(interval?.end) || interval.end <= interval.start)) {
      throw new Error('empty export interval');
    }
    const outputDuration = plan.outputDurationMs;
    const cueLists = [plan.cues?.main, plan.cues?.extension].filter(Array.isArray);
    if (cueLists.flat().some((cue) => cue.startMs < 0 || cue.endMs > outputDuration || cue.endMs <= cue.startMs)) {
      throw new Error('export cue outside output duration');
    }
    if ((Array.isArray(plan.stickers) ? plan.stickers : []).some((sticker) => (
      sticker.startMs < 0 || sticker.endMs > outputDuration || sticker.endMs <= sticker.startMs
    ))) throw new Error('export sticker outside output duration');
    return plan;
  }

  function exportPlanFrame(plan, ms, rounding) {
    return exportMsToFrames(ms, plan.frameProfile, rounding);
  }

  function formatSrtTime(ms) {
    const value = Math.max(0, Math.round(Number(ms) || 0));
    const hours = Math.floor(value / 3600000);
    const minutes = Math.floor((value % 3600000) / 60000);
    const seconds = Math.floor((value % 60000) / 1000);
    const milliseconds = value % 1000;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(milliseconds).padStart(3, '0')}`;
  }

  function selectedSubtitleTracks(plan, subtitleTracks) {
    const selected = subtitleTracks === 'main_and_extension' || subtitleTracks === 'both'
      ? ['main', 'extension'] : subtitleTracks === 'extension' ? ['extension'] : ['main'];
    return selected.flatMap((track) => Array.isArray(plan.cues?.[track]) ? plan.cues[track] : []);
  }

  function serializeMappedSrt(plan, options = {}) {
    const exportPlan = assertExportPlan(plan);
    if (options.subtitleTracks !== undefined && !EXPORT_SUBTITLE_TRACKS.includes(options.subtitleTracks)) {
      throw new Error(`unsupported subtitle tracks: ${options.subtitleTracks}`);
    }
    const tracks = selectedSubtitleTracks(exportPlan, options.subtitleTracks || 'main');
    return `${tracks.map((cue, index) => {
      const start = Math.max(0, Math.round(Number(cue.startMs) || 0));
      const end = Math.max(start + 1, Math.round(Number(cue.endMs) || 0));
      return `${index + 1}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${String(cue.text || '')}\n`;
    }).join('\n')}`;
  }

  function fcpRate(profile) {
    return `<rate><timebase>${profile.numerator}/${profile.denominator}</timebase><ntsc>${profile.denominator === 1001 ? 'TRUE' : 'FALSE'}</ntsc></rate>`;
  }

  function fcpTimeRange(startMs, endMs, plan) {
    const start = exportPlanFrame(plan, startMs, 'floor');
    const end = Math.max(start + 1, exportPlanFrame(plan, endMs, 'ceil'));
    return { start, end, duration: end - start };
  }

  function encodeGraphicAndTypeText(text, fontFamily = 'FangSong') {
    const payload = {
      mTextParam: {
        mAlignment: 0,
        mBackFillColor: 0,
        mBackFillOpacity: 100,
        mBackFillSize: 0,
        mBackFillVisible: false,
        mDefaultRun: [],
        mHeight: 0,
        mHindiDigits: false,
        mIndic: false,
        mIsMask: false,
        mIsMaskInverted: false,
        mIsVerticalText: false,
        mLeading: 0,
        mLigatures: false,
        mLineCapType: 0,
        mLineJoinType: 0,
        mMiterLimit: 2.5,
        mNumStrokes: 1,
        mRTL: false,
        mShadowAngle: 0,
        mShadowBlur: 0,
        mShadowColor: 0,
        mShadowOffset: 0,
        mShadowOpacity: 0,
        mShadowSize: 0,
        mShadowVisible: false,
        mStyleSheet: {
          mAdditionalStrokeColor: [],
          mAdditionalStrokeVisible: [],
          mAdditionalStrokeWidth: [],
          mBaselineOption: { mParamValues: [[0, 0]] },
          mBaselineShift: { mParamValues: [[0, 0]] },
          mCapsOption: { mParamValues: [[0, 0]] },
          mFauxBold: { mParamValues: [[0, false]] },
          mFauxItalic: { mParamValues: [[0, false]] },
          mFillColor: { mParamValues: [[0, 16777215]] },
          mFillOverStroke: { mParamValues: [[0, true]] },
          mFillVisible: { mParamValues: [[0, true]] },
          mFontName: { mParamValues: [[0, fontFamily]] },
          mFontSize: { mParamValues: [[0, 120]] },
          mKerning: { mParamValues: [[0, 0]] },
          mStrokeColor: { mParamValues: [[0, 16777215]] },
          mStrokeVisible: { mParamValues: [[0, false]] },
          mStrokeWidth: { mParamValues: [[0, 1]] },
          mText: String(text ?? ''),
          mTracking: { mParamValues: [[0, 0]] },
          mTsumi: { mParamValues: [[0, 0]] },
          mUnderline: { mParamValues: [[0, false]] },
        },
        mTabWidth: 400,
        mWidth: 0,
      },
      mVersion: 1,
    };
    const json = JSON.stringify(payload);
    const bytes = new Uint8Array(8 + json.length * 2);
    bytes[0] = 0xf6;
    bytes[1] = 0x0a;
    for (let index = 0; index < json.length; index += 1) {
      const code = json.charCodeAt(index);
      bytes[8 + index * 2] = code & 0xff;
      bytes[9 + index * 2] = code >>> 8;
    }
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    if (typeof globalThis.btoa === 'function') return globalThis.btoa(binary);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let encoded = '';
    for (let index = 0; index < bytes.length; index += 3) {
      const first = bytes[index];
      const second = bytes[index + 1];
      const third = bytes[index + 2];
      encoded += alphabet[first >> 2];
      encoded += alphabet[((first & 3) << 4) | (second === undefined ? 0 : second >> 4)];
      encoded += second === undefined ? '=' : alphabet[((second & 15) << 2) | (third === undefined ? 0 : third >> 6)];
      encoded += third === undefined ? '=' : alphabet[third & 63];
    }
    return encoded;
  }

  function premiereFontFamily(value) {
    const key = String(value ?? '').trim();
    return ({
      default: 'Arial',
      yahei: 'Microsoft YaHei',
      hei: 'SimHei',
      song: 'FangSong',
      sans: 'Arial',
    })[key] || key || 'Arial';
  }

  function fcpClipItem({ id, fileId, name, path, width, height, sourceStartMs, sourceEndMs, startMs, endMs, startFrame, endFrame, plan, mediaKind, track, link, defineFile = true, encodeDriveColon = false }) {
    const source = fcpTimeRange(sourceStartMs, sourceEndMs, plan);
    const timeline = fcpTimeRange(startMs, endMs, plan);
    const url = escapeExportXml(exportPathToFileUrl(path, { encodeDriveColon }));
    const isSticker = mediaKind === 'sticker';
    const media = mediaKind === 'audio' ? '<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex><channel>1</channel><channelcount>2</channelcount></sourcetrack>'
      : '<sourcetrack><mediatype>video</mediatype><trackindex>1</trackindex></sourcetrack>';
    const sourceDuration = exportPlanFrame(plan, plan.sourceDurationMs, 'ceil');
    const fileMedia = mediaKind === 'audio'
      ? `<media><audio><duration>${sourceDuration}</duration><channelcount>2</channelcount></audio></media>`
      : isSticker
        ? `<media><video><samplecharacteristics><rate><timebase>${plan.frameProfile.numerator}/${plan.frameProfile.denominator}</timebase><ntsc>${plan.frameProfile.denominator === 1001 ? 'TRUE' : 'FALSE'}</ntsc></rate><width>${Number.isInteger(width) && width > 0 ? width : 720}</width><height>${Number.isInteger(height) && height > 0 ? height : 480}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></video></media>`
        : `<media><video><duration>${sourceDuration}</duration></video><audio><duration>${sourceDuration}</duration><channelcount>2</channelcount></audio></media>`;
    const file = defineFile
      ? `<file id="${escapeExportXml(fileId)}"><name>${escapeExportXml(fileBasename(path))}</name><pathurl>${url}</pathurl><duration>${sourceDuration}</duration>${fcpRate(plan.frameProfile)}${isSticker ? `<timecode><rate>${fcpRate(plan.frameProfile).replace('<rate>', '').replace('</rate>', '')}</rate><string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>` : ''}${fileMedia}</file>`
      : `<file id="${escapeExportXml(fileId)}"/>`;
    const frameStart = startFrame ?? timeline.start;
    const frameEnd = Math.max(frameStart + 1, endFrame ?? frameStart + source.duration);
    const stickerClipMetadata = isSticker
      ? `<enabled>TRUE</enabled><alphatype>${/\.(?:gif|png|webp)$/iu.test(path) ? 'straight' : 'none'}</alphatype><pixelaspectratio>square</pixelaspectratio><anamorphic>FALSE</anamorphic>`
      : '';
    const masterClipMetadata = isSticker ? `<masterclipid>${escapeExportXml(fileId.replace(/^file-/, 'master-'))}</masterclipid>` : '';
    return `<clipitem id="${escapeExportXml(id)}">${masterClipMetadata}<name>${escapeExportXml(name)}</name>${stickerClipMetadata}<duration>${frameEnd - frameStart}</duration>${fcpRate(plan.frameProfile)}<start>${frameStart}</start><end>${frameEnd}</end><in>${source.start}</in><out>${source.end}</out>${file}${media}${link ? `<link><linkclipref>${escapeExportXml(link)}</linkclipref><mediatype>audio</mediatype><trackindex>1</trackindex><clipindex>1</clipindex></link>` : ''}<label>${escapeExportXml(track)}</label></clipitem>`;
  }

  function serializeFcp7Xml(plan, options = {}) {
    const exportPlan = assertExportPlan(plan);
    if (options.nativeTextObjects !== undefined && typeof options.nativeTextObjects !== 'boolean') {
      throw new Error('native text option must be boolean');
    }
    const nativeTextObjects = options.nativeTextObjects === true;
    const subtitleTracks = options.subtitleTracks || 'main';
    if (!EXPORT_SUBTITLE_TRACKS.includes(subtitleTracks)) {
      throw new Error(`unsupported subtitle tracks: ${subtitleTracks}`);
    }
    const mediaType = String(exportPlan.media.type || 'video').toLowerCase();
    const hasVideo = mediaType !== 'audio';
    let cursor = 0;
    const sourceTracks = [];
    const intervals = Array.isArray(exportPlan.keptIntervals) ? exportPlan.keptIntervals : [];
    const boundaries = [0];
    intervals.forEach((interval) => boundaries.push(boundaries[boundaries.length - 1]
      + fcpTimeRange(interval.start, interval.end, exportPlan).duration));
    const duration = boundaries[boundaries.length - 1];
    intervals.forEach((interval, index) => {
      const range = fcpTimeRange(interval.start, interval.end, exportPlan);
      const startMs = cursor * 1000 * exportPlan.frameProfile.denominator / exportPlan.frameProfile.numerator;
      const endMs = (cursor + range.duration) * 1000 * exportPlan.frameProfile.denominator / exportPlan.frameProfile.numerator;
      sourceTracks.push(fcpClipItem({
        id: `video-clip-${index + 1}`, fileId: 'file-source-video-1', name: `${fileBasename(exportPlan.media.path)} [${index + 1}]`,
        path: exportPlan.media.path, sourceStartMs: interval.start, sourceEndMs: interval.end,
        startMs, endMs, startFrame: boundaries[index], endFrame: boundaries[index + 1], plan: exportPlan, mediaKind: mediaType, track: 'source', defineFile: index === 0,
      }));
      cursor += range.duration;
    });
    const audioTracks = hasVideo ? intervals.map((interval, index) => {
      const range = fcpTimeRange(interval.start, interval.end, exportPlan);
      const startMs = (intervals.slice(0, index).reduce((sum, prior) => sum + fcpTimeRange(prior.start, prior.end, exportPlan).duration, 0)) * 1000 * exportPlan.frameProfile.denominator / exportPlan.frameProfile.numerator;
      const endMs = startMs + range.duration * 1000 * exportPlan.frameProfile.denominator / exportPlan.frameProfile.numerator;
      return fcpClipItem({ id: `audio-clip-${index + 1}`, fileId: 'file-source-audio', name: `${fileBasename(exportPlan.media.path)} audio [${index + 1}]`, path: exportPlan.media.path, sourceStartMs: interval.start, sourceEndMs: interval.end, startMs, endMs, startFrame: boundaries[index], endFrame: boundaries[index + 1], plan: exportPlan, mediaKind: 'audio', track: 'source-audio', link: `video-clip-${index + 1}`, defineFile: index === 0 });
    }) : [];
    const videoTracks = hasVideo ? [`<track>${sourceTracks.join('')}</track>`] : [];
    const stickerFileIds = new Map();
    const stickerTracks = hasVideo ? (Array.isArray(exportPlan.stickers) ? exportPlan.stickers : []).map((sticker, index) => {
      if (!String(sticker.path || '').trim()) return '';
      const stickerKey = String(sticker.path);
      const fileId = stickerFileIds.get(stickerKey) || `file-sticker-${stickerFileIds.size + 1}`;
      const defineFile = !stickerFileIds.has(stickerKey);
      stickerFileIds.set(stickerKey, fileId);
      const clip = fcpClipItem({
        id: `sticker-clip-${index + 1}`, fileId, name: `MAW sticker - ${sticker.name || index + 1}`,
        path: sticker.path, width: sticker.width, height: sticker.height, sourceStartMs: 0,
        sourceEndMs: Math.max(1, sticker.endMs - sticker.startMs),
        startMs: sticker.startMs, endMs: sticker.endMs, plan: exportPlan, mediaKind: 'sticker', track: `sticker-${index + 1}`,
        defineFile, encodeDriveColon: true,
      });
      return `<track>${clip}</track>`;
    }).filter(Boolean) : [];
    const textTracks = nativeTextObjects && hasVideo ? (subtitleTracks === 'main_and_extension' || subtitleTracks === 'both'
      ? ['main', 'extension'] : subtitleTracks === 'extension' ? ['extension'] : ['main']).map((track) => {
      const cues = selectedSubtitleTracks(exportPlan, track);
      const generators = cues.map((cue, index) => {
        const range = fcpTimeRange(cue.startMs, cue.endMs, exportPlan);
        const text = encodeGraphicAndTypeText(cue.text, exportPlan.subtitleFontFamily);
        const clipId = `text-${track}-${index + 1}`;
        return `<clipitem id="${clipId}"><name>MAW native text - ${escapeExportXml(track)}</name><enabled>TRUE</enabled><duration>${range.duration}</duration>${fcpRate(exportPlan.frameProfile)}<start>${range.start}</start><end>${range.end}</end><in>0</in><out>${range.duration}</out><file id="file-${clipId}"><name>MAW GraphicAndType</name><mediaSource>GraphicAndType</mediaSource><duration>${range.duration}</duration>${fcpRate(exportPlan.frameProfile)}<media><video><duration>${range.duration}</duration></video></media></file><filter><effect><name>GraphicAndType</name><effectid>GraphicAndType</effectid><effectcategory>graphic</effectcategory><effecttype>filter</effecttype><mediatype>video</mediatype><parameter authoringApp="MAW"><parameterid>1</parameterid><name>Source Text</name><value>${text}</value></parameter></effect></filter></clipitem>`;
      }).join('');
      return generators ? `<track>${generators}</track>` : '';
    }).filter(Boolean) : [];
    const video = hasVideo ? `<video>${videoTracks.concat(stickerTracks, textTracks).join('')}</video>` : '';
    const audio = mediaType === 'audio' ? `<audio><track>${sourceTracks.join('')}</track></audio>` : `<audio><track>${audioTracks.join('')}</track></audio>`;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="5"><sequence id="MAW-sequence"><name>MAW FCP 7 Premiere handoff</name><duration>${duration}</duration>${fcpRate(exportPlan.frameProfile)}<media>${video}${audio}</media></sequence></xmeml>`;
    return xml;
  }

  function buildFcp7ExportArtifacts(plan, options = {}) {
    const exportPlan = assertExportPlan(plan);
    const normalized = normalizeExportOptions({
      timelineMode: exportPlan.mode,
      fps: exportPlan.frameProfile.name,
      ...options,
    });
    if (normalized.timelineMode !== exportPlan.mode
      || normalized.fps !== exportPlan.frameProfile.name) {
      throw new Error('export artifact options do not match the shared plan');
    }
    const names = buildExportNames(normalized.baseName);
    const serializerOptions = {
      nativeTextObjects: normalized.nativeTextObjects,
      subtitleTracks: normalized.subtitleTracks,
    };
    return freezeExportValue([
      {
        kind: 'xml', filename: names.files.project, mime: 'application/xml',
        content: serializeFcp7Xml(exportPlan, serializerOptions), plan: exportPlan,
      },
      {
        kind: 'srt', filename: names.files.subtitles, mime: 'text/plain',
        content: serializeMappedSrt(exportPlan, serializerOptions), plan: exportPlan,
      },
    ]);
  }

  const EXPORT_SAVE_STATUSES = Object.freeze(['cancelled', 'failed', 'dispatched', 'saved']);

  async function saveSequentialExportArtifacts(artifacts, saveArtifact) {
    if (!Array.isArray(artifacts) || artifacts.length !== 2
      || artifacts[0]?.kind !== 'xml' || artifacts[1]?.kind !== 'srt') {
      throw new Error('export artifacts must contain XML then SRT');
    }
    if (typeof saveArtifact !== 'function') throw new Error('save artifact callback is required');
    const outcomes = { xml: 'not_attempted', srt: 'not_attempted', complete: false };
    for (const artifact of artifacts) {
      const result = await saveArtifact(artifact);
      const status = result?.status;
      if (!EXPORT_SAVE_STATUSES.includes(status)) throw new Error(`invalid export save status: ${status}`);
      outcomes[artifact.kind] = status;
      if (status === 'cancelled' || status === 'failed') return freezeExportValue(outcomes);
    }
    outcomes.complete = true;
    return freezeExportValue(outcomes);
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
    x: 0.1, y: 0.76, width: 0.8, height: 0.16,
  });
  // 复刻原 CSS bottom:8% 的带状：y=0.76, height=0.16 → 76%→92%，留 8% 底边距；宽度默认 80% 居中。
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
    subtitleFontFamilyDisplayName,
    decodeSubtitleText,
    normalizeKeyboardOperationReferenceMode,
    resolveKeyboardOperationReference,
    buildReplacementPreview,
    applyTextProcessing,
    buildTextProcessingPreview,
    buildTimedTextDiff,
    timedTextItemCoverage,
    timedTextItemReuse,
    buildTimedTextBoundaryPlan,
    buildTimedTextStructurePlan,
    buildTimedTextEditReport,
    applyTimedTextEdit,
    countTextUnits,
    countSubtitleUnits,
    cueMetrics,
    joinSegmentTexts,
    subtitleTextLength,
    isShortSubtitleText,
    normalizeSegmentTimings,
    normalizeItemTimingRanges,
    planAutoMerge,
    applyAutoMergeSnaps,
    planSubtitleExtension,
    applySubtitleExtension,
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
    isWordSplitConnector,
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
    normalizeEditorSettings,
    normalizeMultiSubtitleRowHeight,
    normalizeClickBehavior,
    normalizeClickTarget,
    normalizeKeyboardOperationReferenceMode,
    normalizeJklPlaybackMode,
    clampMediaSeekStepMs,
    clampCueMoveStepMs,
    clampAutoSaveInterval,
    clampCharcountThreshold,
    clampNinjaSlashLength,
    clampNinjaSlashRotateAmplitude,
    clampAutoMergeGapMs,
    clampAutoMergeShortCount,
    normalizeGapRemoveData,
    buildSegmentsHistorySnapshot,
    buildHistoryRecord,
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
    EXPORT_FRAME_PROFILES,
    resolveExportFrameProfile,
    exportMsToFrames,
    mapExportTime,
    exportPolicyMsToFrames,
    normalizeExportOptions,
    sanitizeExportName,
    buildExportNames,
    escapeExportXml,
    exportPathToFileUrl,
    buildProjectExportPlan,
    serializeMappedSrt,
    serializeFcp7Xml,
    buildFcp7ExportArtifacts,
    saveSequentialExportArtifacts,
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
  if (window.MAWE?.register) {
    window.MAWE.register('editor-utils', () => window.AsrEditorUtils);
  }
})();
