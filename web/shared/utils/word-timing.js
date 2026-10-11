// Existing items are timed text ranges, not necessarily individual words.
export function createWordTiming(dependencies) {
  'use strict';
  const { cloneJsonValue, isTimedTextNeutralToken, uniqueStableSegmentId } = dependencies;
  const neutral = ch => isTimedTextNeutralToken(ch, true);
  const audible = text => Array.from(String(text || '')).filter(ch => !neutral(ch));
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

  // Reattach neutral characters from the sentence without inventing time.
  // Require an exact audible sequence, including repeated words, before mapping.
  function wordTextsFromSource(text, entries) {
    if (!entries.length) return null;
    const source = Array.from(String(text || ''));
    const counts = entries.map(entry => audible(entry.item.text).length);
    if (audible(text).join('') !== entries.map(entry => audible(entry.item.text).join('')).join('')) return null;
    const texts = entries.map(() => '');
    let owner = 0, used = 0;
    for (const ch of source) {
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
    const texts = entries.map(() => '');
    let owner = 0, audibleIndex = 0;
    for (const token of source) {
      if (neutral(token)) texts[owner] += token;
      else {
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

  function planWordTimingConversion(segments, indices, timing) {
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
    const output = segments.flatMap((segment, index) => {
      const pieces = byIndex.get(index)?.segments || [cloneJsonValue(segment)];
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
      });
      return pieces;
    });
    return { segments: output, conversions, skipped, generatedCount: conversions.reduce((n, c) => n + c.segments.length, 0) };
  }

  // Map each audible item to its contiguous [start, end) character span in the
  // sentence text. Neutral characters attach to the preceding audible item and
  // leading text to the first one, exactly like full-coverage display. Returns
  // null unless items cover the audible text completely and in order.
  function wordCharRanges(text, items) {
    const source = Array.from(String(text || ''));
    const counts = items.map(item => audible(item?.text).length);
    if (audible(text).join('') !== items.map((item, index) => audible(item?.text).join('')).join('')) return null;
    const spans = items.map(() => null);
    let owner = counts.findIndex(count => count > 0);
    if (owner < 0) return null;
    let used = 0;
    let spanStart = 0;
    for (let offset = 0; offset < source.length; offset += 1) {
      const ch = source[offset];
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

  // Equal-length text replacement (typo fixes) remaps item texts in place;
  // other edits stay untouched and only warn when they cross timed ranges.
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
      ranges.forEach((range, index) => {
        if (!range) return;
        const next = nextChars.slice(range.start, range.end).join('');
        if (next && next !== nextItems[index]?.text) { nextItems[index].text = next; changed += 1; }
      });
      return changed ? { items: nextItems, changed } : null;
    }
    let prefix = 0;
    const limit = Math.min(previousChars.length, nextChars.length);
    while (prefix < limit && previousChars[prefix] === nextChars[prefix]) prefix += 1;
    let suffix = 0;
    while (suffix < limit - prefix
        && previousChars[previousChars.length - 1 - suffix] === nextChars[nextChars.length - 1 - suffix]) suffix += 1;
    const regionStart = prefix, regionEnd = previousChars.length - suffix;
    const crosses = ranges.some(range => range && range.start < regionEnd && range.end > regionStart);
    if (!crosses) return null;
    return {
      warn: true,
      before: previousChars.slice(regionStart, regionEnd).join(''),
      after: nextChars.slice(prefix, nextChars.length - suffix).join(''),
    };
  }
  return Object.freeze({ getWordTimingEntries, editWordTiming, mergeWordTimingItems, planWordTimingConversion, planWordTimingTextSync });
}
