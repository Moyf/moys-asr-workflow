// word-split: private helpers; dependencies are injected by editor-utils.js.
window.MAWE.register('utils-word-split', function createUtilsModule(dependencies) {
  'use strict';
  const { cleanSplitTextParts } = dependencies;


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

  return Object.freeze({ isWordSplitConnector, nearestSubtitleSplitOffset, splitSubtitleText, subtitleSplitOffsets });
});
