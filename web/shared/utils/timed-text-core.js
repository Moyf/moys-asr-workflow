// timed-text-core: private helpers; dependencies are injected by editor-utils.js.
window.MAWE.register('utils-timed-text-core', function createUtilsModule(dependencies) {
  'use strict';
  const { cloneJsonValue } = dependencies;


  function timedTextTokens(text) {
    return Array.from(String(text == null ? '' : text));
  }


  function isTimedTextWhitespace(token) {
    return /\s/u.test(token);
  }


  // 标点、符号和 emoji 不代表新的可听内容。它们仍保留在 item 文本中，
  // 但不单独占用时间；ZWJ / variation selector / keycap 也视为同一类字符。
  function isTimedTextNeutralToken(token, includeWhitespace = false) {
    if (includeWhitespace && isTimedTextWhitespace(token)) return true;
    return /[\p{P}\p{S}]/u.test(token)
      || /[\u200D\uFE0E\uFE0F\u20E3]/u.test(token);
  }


  function isTimedTextNeutralItem(item) {
    const tokens = timedTextTokens(item?.text);
    return tokens.length > 0 && tokens.every((token) => isTimedTextNeutralToken(token, true));
  }


  // 早期版本可能把没有独立时间的标点保存成 0ms item。保存前将这类字符
  // 并入相邻的有时间 item：既保留原有字词时间，也避免修复器把它扩成越界的 100ms。
  // 如果用户已经删掉该字符，则清理残留 item，避免错误一直留在工程里。
  function normalizeTimedTextNeutralItems(segment) {
    if (!segment || typeof segment !== 'object' || !Array.isArray(segment.items)) return 0;
    const targetTokens = timedTextTokens(segment.text);
    const repaired = [];
    let targetOffset = 0;
    let pendingNeutral = '';
    let fixed = 0;
    const matchesAtOffset = (tokens) => tokens.length > 0
      && targetTokens.length >= targetOffset + tokens.length
      && tokens.every((token, index) => targetTokens[targetOffset + index] === token);

    segment.items.forEach((rawItem) => {
      const itemTokens = timedTextTokens(rawItem?.text);
      if (isTimedTextNeutralItem(rawItem)) {
        if (!matchesAtOffset(itemTokens)) {
          fixed += 1;
          return;
        }
        targetOffset += itemTokens.length;
        const text = itemTokens.join('');
        if (repaired.length) {
          repaired[repaired.length - 1].text += text;
          fixed += 1;
        } else {
          pendingNeutral += text;
          fixed += 1;
        }
        return;
      }

      const copy = cloneJsonValue(rawItem);
      if (pendingNeutral) {
        copy.text = `${pendingNeutral}${String(copy.text == null ? '' : copy.text)}`;
        pendingNeutral = '';
        fixed += 1;
      }
      repaired.push(copy);
      if (matchesAtOffset(itemTokens)) targetOffset += itemTokens.length;
    });

    // 只有纯标点、emoji 的 item 没有可承载其文本的有时间 item；保留空数组即可。
    if (pendingNeutral) fixed += 1;
    if (fixed > 0) segment.items = repaired;
    return fixed;
  }


  function timedTextItemCoverageMask(text, rawItems) {
    const sourceTokens = timedTextTokens(text);
    const targetTokens = sourceTokens.filter((token) => !isTimedTextNeutralToken(token, true));
    const items = Array.isArray(rawItems) ? rawItems : [];
    const itemTokens = [];
    const itemCoverage = [];
    let validItemCount = 0;
    items.forEach((item) => {
      const tokens = timedTextTokens(item?.text)
        .filter((token) => !isTimedTextNeutralToken(token, true));
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


  function timedTextNeutralInsertionItems(originalText, layout, newText, includeWhitespace = false) {
    if (!layout || !Array.isArray(layout.items) || !layout.items.length) return null;
    const sourceTokens = timedTextTokens(originalText);
    const targetTokens = timedTextTokens(newText);
    if (targetTokens.length <= sourceTokens.length) return null;
    const isNeutral = (token) => isTimedTextNeutralToken(token, includeWhitespace);
    const entries = [];
    let sourceIndex = 0;
    let insertedNeutral = false;
    for (const token of targetTokens) {
      if (sourceIndex < sourceTokens.length && token === sourceTokens[sourceIndex]) {
        entries.push({ type: 'source', index: sourceIndex });
        sourceIndex += 1;
      } else if (isNeutral(token)) {
        entries.push({ type: 'neutral', position: sourceIndex, token });
        insertedNeutral = true;
      } else {
        return null;
      }
    }
    if (!insertedNeutral || sourceIndex !== sourceTokens.length) return null;

    const { items, spans } = layout;
    const sourceLength = sourceTokens.length;
    const itemIndexAt = (position) => {
      if (position <= 0) return 0;
      if (position >= sourceLength) return spans.length - 1;
      return spans.findIndex((span) => position < span.end);
    };
    const itemTimeAt = (itemIndex, position) => {
      const item = items[itemIndex];
      const span = spans[itemIndex];
      const start = Number(item?.start);
      const end = Number(item?.end);
      if (!span || !Number.isFinite(start) || !Number.isFinite(end)) return null;
      const length = Math.max(1, span.end - span.start);
      const offset = Math.max(0, Math.min(length, position - span.start));
      return Math.round(start + ((end - start) * offset) / length);
    };
    const result = [];
    let pendingNeutral = '';
    const appendNeutral = (text) => {
      if (!text) return;
      if (result.length) result[result.length - 1].text += text;
      else pendingNeutral += text;
    };
    const appendSourceRange = (rangeStart, rangeEnd) => {
      let cursor = rangeStart;
      while (cursor < rangeEnd) {
        const itemIndex = itemIndexAt(cursor);
        const span = spans[itemIndex];
        if (!span) return false;
        const chunkEnd = Math.min(rangeEnd, span.end);
        const copy = cloneJsonValue(items[itemIndex]);
        copy.text = sourceTokens.slice(cursor, chunkEnd).join('');
        copy.start = itemTimeAt(itemIndex, cursor);
        copy.end = itemTimeAt(itemIndex, chunkEnd);
        if (copy.start === null || copy.end === null) return false;
        if (cursor !== span.start || chunkEnd !== span.end) delete copy.id;
        if (pendingNeutral) {
          copy.text = `${pendingNeutral}${copy.text}`;
          pendingNeutral = '';
        }
        result.push(copy);
        cursor = chunkEnd;
      }
      return true;
    };

    let entryIndex = 0;
    while (entryIndex < entries.length) {
      const entry = entries[entryIndex];
      if (entry.type === 'neutral') {
        const position = entry.position;
        let text = '';
        while (entryIndex < entries.length
            && entries[entryIndex].type === 'neutral'
            && entries[entryIndex].position === position) {
          text += entries[entryIndex].token;
          entryIndex += 1;
        }
        appendNeutral(text);
        continue;
      }
      const rangeStart = entry.index;
      let rangeEnd = rangeStart + 1;
      entryIndex += 1;
      while (entryIndex < entries.length
          && entries[entryIndex].type === 'source'
          && entries[entryIndex].index === rangeEnd) {
        rangeEnd += 1;
        entryIndex += 1;
      }
      if (!appendSourceRange(rangeStart, rangeEnd)) return null;
    }
    if (pendingNeutral) {
      if (!result.length) return null;
      result[result.length - 1].text += pendingNeutral;
    }
    if (result.map((item) => item.text).join('') !== String(newText == null ? '' : newText)
        || !timedTextItemsOrdered(result)) return null;
    return result;
  }


  function sameTimedTextTokens(left, right) {
    return left.length === right.length && left.every((token, index) => token === right[index]);
  }


  function hasTimedTextContent(tokens) {
    return tokens.some((token) => token.trim() !== '');
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

  return Object.freeze({ buildTimedTextDiff, hasTimedTextContent, isTimedTextNeutralToken, normalizeTimedTextNeutralItems, sameTimedTextTokens, timedTextDiffOpcodes, timedTextItemCoverage, timedTextItemLayout, timedTextItemReuse, timedTextItemsOrdered, timedTextItemsPartition, timedTextItemsSlice, timedTextNeutralInsertionItems, timedTextTokens });
});
