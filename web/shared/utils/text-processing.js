// text-processing: private helpers; dependencies are injected by editor-utils.js.
export function createUtilsModule(dependencies) {
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
    if (options.skipWrapped && options.addPrefix && options.addSuffix
        && isTextWrappedBy(result, options.prefix, options.suffix)) return result;
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

  // ASS 单句渐入渐出标记：`>>` 在整行行首表示淡入，`<<` 在整行行尾表示淡出，
  // 两端同时出现即淡入 + 淡出。none 保留原文；both（含旧值 single）
  // 也识别单个 `>` / `<`。未指定规则时仅识别双符号。
  function parseSentenceFadeMarkers(text, rule) {
    const source = String(text == null ? '' : text);
    if (rule === 'none') return { text: source, fadeIn: false, fadeOut: false };
    const singleAllowed = rule === 'both' || rule === 'single';
    let body = source;
    let fadeIn = false;
    let fadeOut = false;
    if (body.startsWith('>>')) body = body.slice(2), fadeIn = true;
    else if (singleAllowed && body.startsWith('>')) body = body.slice(1), fadeIn = true;
    if (body.endsWith('<<')) body = body.slice(0, -2), fadeOut = true;
    else if (singleAllowed && body.endsWith('<')) body = body.slice(0, -1), fadeOut = true;
    return { text: (fadeIn || fadeOut) ? body : source, fadeIn, fadeOut };
  }


  function stripSentenceFadeMarkers(text, rule) {
    return parseSentenceFadeMarkers(text, rule).text;
  }


  // 「左右添加字符」预设：主字幕右键菜单与批量面板共用同一张数据表，便于后续加项。
  // 一律使用双符号形式；「单双符号」设置只影响识别/解析，不影响这里插入的内容。
  const WRAP_CHAR_PRESETS = Object.freeze([
    // ass: true 的预设是 ASS 特殊文本格式，仅在当前工程启用 ASS 字幕模式时展示。
    { id: 'emphasis', label: '强调文本', left: '**', right: '**', ass: true },
    { id: 'large', label: '放大文本', left: '++', right: '++', ass: true },
    { id: 'small', label: '缩小文本', left: '--', right: '--', ass: true },
    { id: 'underline', label: '下划线', left: '__', right: '__', ass: true },
    { id: 'strike', label: '删除线', left: '~~', right: '~~', ass: true },
    { id: 'fade', label: '淡出淡入', left: '>>', right: '<<', ass: true },
    { id: 'note', label: '音符', left: '♪', right: '♪' },
    { id: 'music', label: '双音符', left: '♬', right: '♬' },
    { id: 'bracket', label: '中括号', left: '[', right: ']' },
  ]);


  function isTextWrappedBy(text, left, right) {
    const source = String(text == null ? '' : text);
    const l = String(left == null ? '' : left);
    const r = String(right == null ? '' : right);
    if (!l || !r || source.length < l.length + r.length) return false;
    return source.startsWith(l) && source.endsWith(r);
  }


  // 在文本两端插入字符。已用同一对符号包裹时跳过（同一对双符号不重复包），
  // skipped 供调用方提示；空文本与空符号视为无操作。
  function wrapCharsAroundText(text, left, right) {
    const source = String(text == null ? '' : text);
    const l = String(left == null ? '' : left);
    const r = String(right == null ? '' : right);
    if (source === '' || (!l && !r)) return { changed: false, skipped: false, text: source };
    if (isTextWrappedBy(source, l, r)) return { changed: false, skipped: true, text: source };
    return { changed: true, skipped: false, text: `${l}${source}${r}` };
  }


  return Object.freeze({
    applyTextProcessing,
    buildReplacementPreview,
    buildTextProcessingPreview,
    parseSentenceFadeMarkers,
    stripSentenceFadeMarkers,
    WRAP_CHAR_PRESETS,
    isTextWrappedBy,
    wrapCharsAroundText,
  });
}
