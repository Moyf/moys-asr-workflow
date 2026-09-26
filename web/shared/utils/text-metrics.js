// text-metrics: private helpers; dependencies are injected by editor-utils.js.
window.MAWE.register('utils-text-metrics', function createUtilsModule(dependencies) {
  'use strict';
  const { countTextUnits, detectSubtitleSplitMode } = dependencies;


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

  return Object.freeze({ countSubtitleUnits, cueMetrics, isShortSubtitleText, joinSegmentTexts, subtitleTextLength });
});
