// timed-text-core: private helpers; dependencies are injected by editor-utils.js.
export function createUtilsModule(dependencies) {
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


  // 严格布局的校验部分：items 时间码有序合法并给出在原文里的字符区间；
  // checkConcat 为 false 时跳过「拼接文字 == 原文」的检查（宽容回退先用它
  // 单独校验时间码，拼接检查留给重新切齐之后）。
  function timedTextLayoutFromItems(originalText, rawItems, { checkConcat = true } = {}) {
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
    if (checkConcat && spans[spans.length - 1].end !== sourceTokens.length) return null;
    if (checkConcat && items.map((item) => String(item?.text == null ? '' : item.text)).join('') !== originalText) {
      // 等长但内容不同（如空格位置漂移）的 items 会让 spans 整体错位，
      // 按它切片会得到移位的字词时间；交给宽容回退重新对齐。
      return null;
    }
    return { items, spans };
  }


  // 把已对齐 sourceTokens 的 items 重新切齐到 targetTokens：按 LCS 映射移动
  // item 的文字边界（时间码不变），丢弃在目标文字中已不存在的零宽 item；
  // 目标文字里没有 item 认领的空隙（漂移插入的空白/标点/改写字符）吸收进
  // 相邻 item，保证重切后的拼接仍然恰好等于目标文字。调用方负责先校验
  // 漂移可接受（纯中性字符 / 匹配率下限）。
  function recutLayoutItemsOntoTokens(layout, sourceTokens, targetTokens, opcodes) {
    const map = new Array(sourceTokens.length).fill(-1);
    let matched = 0;
    opcodes.forEach((opcode) => {
      if (opcode.tag !== 'equal') return;
      for (let offset = 0; offset < opcode.sourceEnd - opcode.sourceStart; offset += 1) {
        map[opcode.sourceStart + offset] = opcode.targetStart + offset;
        matched += 1;
      }
    });
    if (!matched) return null;
    const cores = [];
    let spanStart = 0;
    for (const item of layout.items) {
      const spanEnd = spanStart + timedTextTokens(item.text).length;
      let start = -1;
      let end = -1;
      for (let index = spanStart; index < spanEnd; index += 1) {
        if (map[index] >= 0) { start = map[index]; break; }
      }
      for (let index = spanEnd - 1; index >= spanStart; index -= 1) {
        if (map[index] >= 0) { end = map[index] + 1; break; }
      }
      // 完整性守门（Greptile P1）：有实义文字的 item 至少 3/4 的非中性字符
      // 要对齐上，否则对齐残骸会把别的词的时间拼凑进来——例如文字删掉了
      // items 里的某个词时，相邻词可能只匹配到碎片却继承被删词的时间还
      // 报告为已复用。此时整组回退估算比给错时间诚实。
      if (start >= 0) {
        let meaningful = 0;
        let hit = 0;
        for (let index = spanStart; index < spanEnd; index += 1) {
          if (isTimedTextNeutralToken(sourceTokens[index], true)) continue;
          meaningful += 1;
          if (map[index] >= 0) hit += 1;
        }
        if (meaningful > 0 && hit / meaningful < 0.75) return null;
      }
      spanStart = spanEnd;
      if (start < 0 || start >= end) continue;
      cores.push({ item, start, end });
    }
    if (!cores.length) return null;
    const recut = [];
    let previousEnd = 0;
    for (const { item, start, end } of cores) {
      const text = targetTokens.slice(previousEnd, Math.max(end, previousEnd)).join('');
      previousEnd = Math.max(end, previousEnd);
      const copy = cloneJsonValue(item);
      if (text !== copy.text) {
        copy.text = text;
        delete copy.id;
      }
      recut.push(copy);
    }
    const last = recut[recut.length - 1];
    if (previousEnd < targetTokens.length) {
      last.text += targetTokens.slice(previousEnd).join('');
      // 追加尾段后文字与原 item 不同，id 不再对应原字词，与上方变更同样丢弃。
      if (last.text !== cores[cores.length - 1].item.text) delete last.id;
    }
    return recut;
  }


  // 宽容布局回退：Qwen 本地 ASR 的词标签自带前后空格、AI 整理改写 text 后
  // 未同步 items 等，都会让 items 拼接文字与 segment.text 出现空白/标点级
  // 漂移，严格布局直接失败并连锁导致拆句/改写全部退化为估算。这里用 LCS
  // 把 items 重新切齐到真实 text（时间码不动，只有中性字符的归属移动），
  // 再用严格校验复核；返回值与严格布局满足同一不变量（items 拼接 == text）。
  function tolerantTimedTextLayout(originalText, rawItems) {
    const sourceTokens = timedTextTokens(originalText);
    // 先只校验 items 时间码本身有序合法（拼接检查留到重新切齐之后）。
    const layout = timedTextLayoutFromItems(originalText, rawItems, { checkConcat: false });
    if (!layout) return null;
    const concatTokens = layout.items.flatMap((item) => timedTextTokens(item.text));
    const opcodes = timedTextDiffOpcodes(concatTokens, sourceTokens);
    if (!opcodes) return null;
    const comparableLength = Math.max(concatTokens.length, sourceTokens.length);
    let matched = 0;
    opcodes.forEach((opcode) => {
      if (opcode.tag === 'equal') matched += opcode.sourceEnd - opcode.sourceStart;
    });
    if (!matched || matched / comparableLength < 0.6) return null;
    const recut = recutLayoutItemsOntoTokens(layout, concatTokens, sourceTokens, opcodes);
    if (!recut) return null;
    return timedTextLayoutFromItems(originalText, recut);
  }


  // 拆分 retime 的漂移回退：切片 items 的拼接文字与目标行文字只差空白/标点
  // （拆分点落在空白上、用户开启「移除前后空格」、锚点吸附中性字符等）时，
  // 把 items 原时间码保留、文字重新切齐到目标行，不降级为估算。
  function timedTextNeutralDriftItems(originalText, layout, newText) {
    if (!layout) return null;
    const sourceTokens = timedTextTokens(originalText);
    const targetTokens = timedTextTokens(newText);
    if (!targetTokens.length) return null;
    const opcodes = timedTextDiffOpcodes(sourceTokens, targetTokens);
    if (!opcodes) return null;
    for (const opcode of opcodes) {
      if (opcode.tag === 'equal') continue;
      for (let index = opcode.sourceStart; index < opcode.sourceEnd; index += 1) {
        if (!isTimedTextNeutralToken(sourceTokens[index], true)) return null;
      }
      for (let index = opcode.targetStart; index < opcode.targetEnd; index += 1) {
        if (!isTimedTextNeutralToken(targetTokens[index], true)) return null;
      }
    }
    const recut = recutLayoutItemsOntoTokens(layout, sourceTokens, targetTokens, opcodes);
    if (!recut) return null;
    return timedTextLayoutFromItems(newText, recut)?.items || null;
  }


  function timedTextItemLayout(originalText, rawItems) {
    if (!Array.isArray(rawItems) || !rawItems.length) return null;
    const strict = timedTextLayoutFromItems(originalText, rawItems);
    if (strict) return strict;
    return tolerantTimedTextLayout(originalText, rawItems);
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

  return Object.freeze({ buildTimedTextDiff, hasTimedTextContent, isTimedTextNeutralToken, normalizeTimedTextNeutralItems, sameTimedTextTokens, timedTextDiffOpcodes, timedTextItemCoverage, timedTextItemLayout, timedTextItemReuse, timedTextItemsOrdered, timedTextItemsPartition, timedTextItemsSlice, timedTextNeutralDriftItems, timedTextNeutralInsertionItems, timedTextTokens });
}
