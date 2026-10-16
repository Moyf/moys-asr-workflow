// Existing items are timed text ranges, not necessarily individual words.
export function createWordTiming(dependencies) {
  'use strict';
  const { cloneJsonValue, completeMassTextRows, isTimedTextNeutralToken, massMarkedRanges, uniqueStableSegmentId } = dependencies;
  const neutral = ch => isTimedTextNeutralToken(ch, true);
  const audible = text => Array.from(String(text || '')).filter(ch => !neutral(ch));
  // 「特殊文本规则」与 assSpecialSymbolRule 设置同源（默认单双皆可）；编辑器
  // 启动与设置变更时经 setMassSymbolRule 同步，纯函数场景可直接调用。
  let activeMassSymbolRule = 'both';
  function setMassSymbolRule(rule) {
    activeMassSymbolRule = ['none', 'single', 'double', 'both'].includes(rule) ? rule : 'both';
    return activeMassSymbolRule;
  }
  function wordClock(timing) {
    if (timing?.unit === 'frames') return timing;
    return { ...timing,
      unit: 'milliseconds', getStart: s => s.start, getEnd: s => s.end,
      getItemStart: s => s.start, getItemEnd: s => s.end,
      setItemStart: (s, v) => { s.start = v; delete s.start_frame; },
      setItemEnd: (s, v) => { s.end = v; delete s.end_frame; },
    };
  }

  function getWordTimingEntries(segment, timing) {
    const clock = wordClock(timing);
    const lower = clock.getStart(segment), upper = clock.getEnd(segment);
    const entries = [];
    if (!Number.isInteger(lower) || !Number.isInteger(upper) || lower < 0 || upper <= lower) return entries;
    let previousEnd = lower;
    (Array.isArray(segment?.items) ? segment.items : []).forEach((item, index) => {
      if (!item || !audible(item.text).length) return;
      const start = clock.getItemStart(item), end = clock.getItemEnd(item);
      if (!Number.isInteger(start) || !Number.isInteger(end)
          || start < lower || end > upper || end <= start || start < previousEnd) return;
      entries.push({ index, item: cloneJsonValue(item), start, end, text: item.text });
      previousEnd = end;
    });
    const texts = wordTextsFromSource(segment?.text, entries) || partialWordTextsFromSource(segment?.text, entries);
    if (texts) entries.forEach((entry, index) => { entry.text = texts[index]; });
    return entries;
  }

  // MASS 成对区间换算成码点下标（assMarkedRanges 用 UTF-16 下标，而词块
  // 遍历按 Array.from 的码点进行；符号字符全为 BMP，宽度两种下标一致）。
  function massPairCodePointRanges(sourceChars, rule) {
    const text = sourceChars.join('');
    const codePointAt = new Array(text.length + 1).fill(-1);
    let offset = 0;
    for (let index = 0; index < sourceChars.length; index += 1) {
      codePointAt[offset] = index;
      offset += sourceChars[index].length;
    }
    codePointAt[offset] = sourceChars.length;
    const ranges = [];
    massMarkedRanges(text, rule).forEach(({ start, end, width }) => {
      const startCodePoint = codePointAt[start];
      const endCodePoint = codePointAt[end];
      if (startCodePoint < 0 || endCodePoint < 0) return;
      ranges.push({ start: startCodePoint, end: endCodePoint, width });
    });
    return ranges;
  }

  // MASS 成对符号归属（同 item 归位规则）：一对符号包裹的全部可听内容落在
  // 单个 item 的 audible 范围内时，两个符号字符都归属该 item；跨 item 的对、
  // 纯中性内容的对与孤儿符号维持「中性字符挂靠前一发音 item」的现状。
  // audibleOwnerAt(offset)：可听字符返回所属 item 下标，中性字符返回 -1，
  // 无法归属（部分匹配未命中的可听字符）返回 null 表示整对放弃。
  function massPairCharOwners(sourceChars, audibleOwnerAt, rule) {
    const owners = new Map();
    massPairCodePointRanges(sourceChars, rule).forEach(({ start, end, width }) => {
      let owner = -1;
      for (let offset = start + width; offset < end; offset += 1) {
        const resolved = audibleOwnerAt(offset);
        if (resolved === null) return;
        if (resolved < 0) continue;
        if (owner >= 0 && resolved !== owner) return;
        owner = resolved;
      }
      if (owner < 0) return;
      for (let offset = start; offset < end + width; offset += 1) owners.set(offset, owner);
    });
    return owners;
  }

  // 精确覆盖场景的可听字符归属表：按 counts 顺序把第 i 个可听字符位映射到
  // 所属 item（与 wordCharRanges 的顺序推进模型一致），中性字符为 -1。
  function countsAudibleOwners(sourceChars, counts) {
    const boundaries = [];
    let total = 0;
    counts.forEach((count) => {
      total += count;
      boundaries.push(total);
    });
    const ownerAt = new Array(sourceChars.length).fill(-1);
    let audibleIndex = 0;
    for (let offset = 0; offset < sourceChars.length; offset += 1) {
      if (neutral(sourceChars[offset])) continue;
      const owner = boundaries.findIndex(boundary => audibleIndex < boundary);
      if (owner < 0) return null;
      ownerAt[offset] = owner;
      audibleIndex += 1;
    }
    return ownerAt;
  }

  // Reattach neutral characters from the sentence without inventing time.
  // Require an exact audible sequence, including repeated words, before mapping.
  function wordTextsFromSource(text, entries) {
    if (!entries.length) return null;
    const source = Array.from(String(text || ''));
    const counts = entries.map(entry => audible(entry.item.text).length);
    if (audible(text).join('') !== entries.map(entry => audible(entry.item.text).join('')).join('')) return null;
    const ownerAt = countsAudibleOwners(source, counts);
    const forcedOwners = ownerAt
      ? massPairCharOwners(source, offset => ownerAt[offset], activeMassSymbolRule)
      : new Map();
    const texts = entries.map(() => '');
    let owner = 0, used = 0;
    for (let offset = 0; offset < source.length; offset += 1) {
      const ch = source[offset];
      const forced = forcedOwners.get(offset);
      // 成对符号整体划给包裹的 item：遇到该 item 的符号时直接跳转归属。
      if (forced !== undefined && forced > owner) {
        owner = forced;
        used = 0;
      }
      if (!neutral(ch) && used === counts[owner] && owner + 1 < entries.length) {
        owner += 1;
        used = 0;
      }
      texts[owner] += ch;
      if (!neutral(ch)) used += 1;
    }
    return texts;
  }

  // Missing audible text stays on the sentence background. Project only when
  // earliest and latest ordered matches agree, so repeated text is unambiguous.
  function partialWordTextsFromSource(text, entries) {
    if (!entries.length) return null;
    const source = Array.from(String(text || ''));
    const tokens = audible(text);
    const words = entries.map(entry => audible(entry.item.text));
    const matches = (word, position) => word.every((token, offset) => tokens[position + offset] === token);
    let cursor = 0;
    const earliest = words.map(word => {
      let position = cursor;
      while (position + word.length <= tokens.length && !matches(word, position)) position += 1;
      cursor = position + word.length;
      return cursor <= tokens.length ? position : -1;
    });
    cursor = tokens.length;
    const latest = words.map(() => -1);
    for (let index = words.length - 1; index >= 0; index -= 1) {
      const word = words[index];
      let position = cursor - word.length;
      while (position >= 0 && !matches(word, position)) position -= 1;
      latest[index] = position;
      cursor = position;
    }
    if (earliest.some((position, index) => position < 0 || position !== latest[index])) return null;
    const owners = new Map();
    words.forEach((word, index) => word.forEach((_, offset) => owners.set(earliest[index] + offset, index)));
    // 与 wordCharRanges / wordTextsFromSource 同一条成对符号归属规则，
    // 否则显示重分配与同步复验会互相打架。
    const audibleIndexAt = new Array(source.length).fill(-1);
    let running = 0;
    for (let offset = 0; offset < source.length; offset += 1) {
      if (!neutral(source[offset])) audibleIndexAt[offset] = running++;
    }
    const forcedOwners = massPairCharOwners(source, (offset) => {
      const audibleIndex = audibleIndexAt[offset];
      if (audibleIndex < 0) return -1;
      return owners.has(audibleIndex) ? owners.get(audibleIndex) : null;
    }, activeMassSymbolRule);
    const texts = entries.map(() => '');
    let owner = 0, audibleIndex = 0;
    for (let offset = 0; offset < source.length; offset += 1) {
      const token = source[offset];
      if (neutral(token)) {
        const forced = forcedOwners.get(offset);
        if (forced !== undefined && forced > owner) owner = forced;
        texts[owner] += token;
      } else {
        const matchedOwner = owners.get(audibleIndex++);
        if (matchedOwner === undefined) continue;
        owner = matchedOwner;
        texts[owner] += token;
      }
    }
    return texts;
  }

  function editWordTiming(segment, indices, edit, timing) {
    if (!Number.isFinite(edit.kind === 'move' ? edit.delta : edit.target)) return null;
    const clock = wordClock(timing);
    const entries = getWordTimingEntries(segment, clock);
    const chosen = entries.filter(entry => indices.includes(entry.index));
    if (!chosen.length || chosen.length !== indices.length) return null;
    const copy = cloneJsonValue(segment.items);
    const lower = clock.getStart(segment), upper = clock.getEnd(segment);
    const write = (entry, start, end) => {
      if (start === entry.start && end === entry.end) return;
      clock.setItemStart(copy[entry.index], start);
      clock.setItemEnd(copy[entry.index], end);
    };
    const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
    if (edit.kind === 'move') {
      let minDelta = -Infinity, maxDelta = Infinity;
      chosen.forEach(entry => {
        const position = entries.indexOf(entry);
        const prev = entries.slice(0, position).reverse().find(e => !indices.includes(e.index));
        const next = entries.slice(position + 1).find(e => !indices.includes(e.index));
        minDelta = Math.max(minDelta, (prev?.end ?? lower) - entry.start);
        maxDelta = Math.min(maxDelta, (next?.start ?? upper) - entry.end);
      });
      if (minDelta > maxDelta) return null;
      const delta = clamp(Math.round(edit.delta), minDelta, maxDelta);
      chosen.forEach(entry => write(entry, entry.start + delta, entry.end + delta));
    } else {
      const entry = chosen[0], position = entries.indexOf(entry);
      const prev = entries[position - 1], next = entries[position + 1];
      const left = edit.edge === 'start';
      const partner = left ? prev : next;
      const linked = edit.linked && partner
        && (left ? partner.end === entry.start : partner.start === entry.end);
      const minimum = left ? (linked ? partner.start + 1 : prev?.end ?? lower) : entry.start + 1;
      const maximum = left ? entry.end - 1 : (linked ? partner.end - 1 : next?.start ?? upper);
      if (minimum > maximum) return null;
      const target = clamp(Math.round(edit.target), minimum, maximum);
      write(entry, left ? target : entry.start, left ? entry.end : target);
      if (linked) write(partner, left ? partner.start : target, left ? target : partner.end);
    }
    return copy;
  }

  function mergeWordTimingItems(segment, indices, timing) {
    const entries = getWordTimingEntries(segment, timing);
    const selected = entries.filter(entry => indices.includes(entry.index));
    if (selected.length < 2 || selected.length !== indices.length) return null;
    const first = selected[0], last = selected.at(-1);
    const range = segment.items.slice(first.index, last.index + 1);
    if (range.some((item, offset) => audible(item?.text).length && !indices.includes(first.index + offset))) return null;
    const speakers = new Set(selected.map(entry => entry.item.speaker ?? segment.speaker ?? ''));
    if (speakers.size !== 1) return null;
    const clock = wordClock(timing);
    const merged = { ...cloneJsonValue(first.item), text: range.map(item => item?.text || '').join('') };
    clock.setItemStart(merged, first.start);
    clock.setItemEnd(merged, last.end);
    const items = cloneJsonValue(segment.items);
    items.splice(first.index, last.index - first.index + 1, merged);
    return items;
  }

  // 字词拆字幕出口的 MASS 补齐（账本 #21）：转换把原句按字词切开，跨行的
  // 成对符号（如 __really fun__ → __really / fun__）按同一 helper 在相邻
  // 输出行两侧补齐。补齐范围锁定在「同一条被转换字幕」切出的相邻输出行
  // 之间（Greptile P1：全量扫描会把未选中字幕里的字面 `*甲`/`乙*` 被相邻
  // junction 补成 `*甲*`/`*乙*`，转换连带保存无关修改）——跨字幕边界本就
  // 不该有语法对，一律不动。
  function conversionRowFollowable(segment) {
    return !Array.isArray(segment?.items)
      || (segment.items.length === 1 && segment.items[0]?.text === segment.text);
  }

  function completeConvertedOutputMassPairs(output, rule, outputSources) {
    const rows = Array.isArray(output) ? output : [];
    const sources = Array.isArray(outputSources) ? outputSources : [];
    if (!rule || rule === 'none') return rows;
    for (let start = 0; start < rows.length;) {
      if (!(sources[start] >= 0) || !conversionRowFollowable(rows[start])) { start += 1; continue; }
      let end = start + 1;
      while (end < rows.length && sources[end] === sources[start] && conversionRowFollowable(rows[end])) end += 1;
      completeMassTextRows(rows.slice(start, end), rule);
      start = end;
    }
    return rows;
  }

  function planWordTimingConversion(segments, indices, timing, options = {}) {
    const clock = wordClock(timing);
    const conversions = [], skipped = [];
    const usedIds = segments.map(s => ({ id: s.id }));
    [...new Set(indices)].sort((a, b) => a - b).forEach(index => {
      const source = segments[index];
      if (!source) return;
      const entries = getWordTimingEntries(source, clock);
      const meaningfulCount = (Array.isArray(source.items) ? source.items : []).filter(item => audible(item?.text).length).length;
      const texts = wordTextsFromSource(source.text, entries);
      let reason = !entries.length ? 'missing' : entries.length !== meaningfulCount ? 'timing' : !texts ? 'text' : null;
      if (!reason && entries.length === 1 && entries[0].start === clock.getStart(source)
          && entries[0].end === clock.getEnd(source) && source.items.length === 1 && source.items[0].text === source.text
          && (entries[0].item.speaker == null || entries[0].item.speaker === source.speaker)) reason = 'unchanged';
      if (reason) { skipped.push({ index, id: source.id, reason }); return; }
      const outputs = entries.map((entry, ordinal) => {
        const item = { ...entry.item, text: texts[ordinal] };
        clock.setItemStart(item, entry.start);
        clock.setItemEnd(item, entry.end);
        const id = uniqueStableSegmentId(usedIds, `${source.id || 'main'}-item-${ordinal + 1}`, 'main');
        usedIds.push({ id });
        const output = { ...cloneJsonValue(source), id, text: item.text, items: [item],
          start: item.start, end: item.end, _dirty: true };
        delete output.start_frame;
        delete output.end_frame;
        if (clock.unit === 'frames') {
          output.start_frame = item.start_frame;
          output.end_frame = item.end_frame;
        }
        if (item.speaker != null) output.speaker = item.speaker;
        return output;
      });
      conversions.push({ index, id: source.id, segments: outputs });
    });
    const byIndex = new Map(conversions.map(c => [c.index, c]));
    const oldToNew = new Map();
    let offset = 0;
    segments.forEach((segment, index) => {
      oldToNew.set(index, offset);
      offset += byIndex.get(index)?.segments.length || 1;
    });
    const output = [];
    const outputSources = [];
    segments.forEach((segment, index) => {
      const pieces = byIndex.get(index)?.segments || [cloneJsonValue(segment)];
      const converted = byIndex.has(index);
      pieces.forEach((piece, ordinal) => {
        for (const field of ['color', 'sticker']) {
          const ref = `${field}_ref`;
          if (ordinal > 0 && segment[field]) {
            piece[field] = null;
            piece[ref] = { name: segment[field].name, headIdx: oldToNew.get(index) };
          } else if (piece[ref]) {
            const mapped = oldToNew.get(piece[ref].headIdx) ?? piece[ref].headIdx;
            if (mapped !== piece[ref].headIdx) piece._dirty = true;
            piece[ref].headIdx = mapped;
          }
        }
        output.push(piece);
        outputSources.push(converted ? index : -1);
      });
    });
    completeConvertedOutputMassPairs(output, options.rule, outputSources);
    return { segments: output, conversions, skipped, generatedCount: conversions.reduce((n, c) => n + c.segments.length, 0) };
  }

  // Map each audible item to its contiguous [start, end) character span in the
  // sentence text. Neutral characters attach to the preceding audible item and
  // leading text to the first one, exactly like full-coverage display. A MASS
  // pair whose wrapped audible content falls entirely inside one item attaches
  // both marker characters to that item instead (same rule as the display
  // redistribution, so sync re-verification cannot disagree). Returns
  // null unless items cover the audible text completely and in order.
  function wordCharRanges(text, items) {
    const source = Array.from(String(text || ''));
    const counts = items.map(item => audible(item?.text).length);
    if (audible(text).join('') !== items.map((item, index) => audible(item?.text).join('')).join('')) return null;
    const ownerAt = countsAudibleOwners(source, counts);
    const forcedOwners = ownerAt
      ? massPairCharOwners(source, offset => ownerAt[offset], activeMassSymbolRule)
      : new Map();
    const spans = items.map(() => null);
    let owner = counts.findIndex(count => count > 0);
    if (owner < 0) return null;
    let used = 0;
    let spanStart = 0;
    for (let offset = 0; offset < source.length; offset += 1) {
      const ch = source[offset];
      const forced = forcedOwners.get(offset);
      // 成对符号整体划给包裹的 item：跨越 item 边界时先收口当前 span。
      if (forced !== undefined && forced > owner) {
        spans[owner] = { start: spanStart, end: offset };
        owner = forced;
        used = 0;
        spanStart = offset;
      }
      if (!neutral(ch) && used === counts[owner]) {
        spans[owner] = { start: spanStart, end: offset };
        do { owner += 1; } while (owner < counts.length && counts[owner] === 0);
        if (owner >= counts.length) return null;
        used = 0;
        spanStart = offset;
      }
      if (!neutral(ch)) used += 1;
    }
    spans[owner] = { start: spanStart, end: source.length };
    return spans;
  }

  // Text edits remap item texts in place when unambiguous: equal-length
  // replacements always do, and unequal edits do when the whole changed region
  // (an insertion point included) stays inside a single item span. Other edits
  // stay untouched and only warn when they cross timed ranges. `details`
  // carries [before, after] per changed item for user-facing hints.
  function planWordTimingTextSync(segment, previousText) {
    const text = segment?.text;
    const items = segment?.items;
    if (!Array.isArray(items) || !items.length) return null;
    if (typeof text !== 'string' || typeof previousText !== 'string' || text === previousText) return null;
    const ranges = wordCharRanges(previousText, items);
    if (!ranges) return null;
    const nextChars = Array.from(text), previousChars = Array.from(previousText);
    if (nextChars.length === previousChars.length) {
      const nextItems = cloneJsonValue(items);
      let changed = 0;
      const details = [];
      ranges.forEach((range, index) => {
        if (!range) return;
        const next = nextChars.slice(range.start, range.end).join('');
        if (next && next !== nextItems[index]?.text) {
          details.push({ before: nextItems[index]?.text ?? '', after: next });
          nextItems[index].text = next;
          changed += 1;
        }
      });
      return changed ? { items: nextItems, changed, details } : null;
    }
    let prefix = 0;
    const limit = Math.min(previousChars.length, nextChars.length);
    while (prefix < limit && previousChars[prefix] === nextChars[prefix]) prefix += 1;
    let suffix = 0;
    while (suffix < limit - prefix
        && previousChars[previousChars.length - 1 - suffix] === nextChars[nextChars.length - 1 - suffix]) suffix += 1;
    const regionStart = prefix, regionEnd = previousChars.length - suffix;
    const nextRegionEnd = nextChars.length - suffix;
    const crossed = ranges.map((range, index) => ({ range, index }))
      .filter(({ range }) => range && range.start < regionEnd && range.end > regionStart);
    // The changed region lies within one item span: write the new span text
    // back with unchanged timing, then re-verify the neutral-character mapping.
    if (crossed.length === 1) {
      const { range, index } = crossed[0];
      if (range.start <= regionStart && regionEnd <= range.end) {
        const next = nextChars.slice(range.start, range.end + nextRegionEnd - regionEnd).join('');
        if (audible(next).length || !audible(items[index]?.text).length) {
          const nextItems = cloneJsonValue(items);
          const before = nextItems[index]?.text ?? '';
          if (next !== before) {
            nextItems[index].text = next;
            if (wordCharRanges(text, nextItems)) {
              return { items: nextItems, changed: 1, details: [{ before, after: next }] };
            }
          }
        }
      }
    }
    if (!crossed.length) return null;
    // 「发音序列不变」静默同步（账本 #25）：非等长编辑只增删了中性字符
    // （MASS/标点/空白）且变更区域无法落进单一 item 时，items 原样保留即为
    // 正确结果——中性归属由显示层的成对符号归位规则自动生效，不再弹
    // 「不是等长替换」警告。等长替换（含标点替换）不受影响，仍走原同步。
    if (audible(text).join('') === audible(previousText).join('')) return null;
    return {
      warn: true,
      before: previousChars.slice(regionStart, regionEnd).join(''),
      after: nextChars.slice(prefix, nextRegionEnd).join(''),
    };
  }
  return Object.freeze({ getWordTimingEntries, editWordTiming, mergeWordTimingItems, planWordTimingConversion, planWordTimingTextSync, setMassSymbolRule });
}
