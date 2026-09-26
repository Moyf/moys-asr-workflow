// text-processing: private helpers; dependencies are injected by editor-utils.js.
window.MAWE.register('utils-text-processing', function createUtilsModule(dependencies) {
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

  return Object.freeze({ applyTextProcessing, buildReplacementPreview, buildTextProcessingPreview });
});
