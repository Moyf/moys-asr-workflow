// text-processing: private helpers; dependencies are injected by editor-utils.js.
export function createUtilsModule(dependencies) {
  'use strict';


  function buildReplacementPreview(segments, indexes, find, replacement, options = {}) {
    if (!find) return { error: null, matchCount: 0, lineCount: 0, rows: [] };
    const compiled = compileTextSearchPattern(find, options);
    if (compiled.error) return { error: compiled.error, matchCount: 0, lineCount: 0, rows: [] };
    let matchCount = 0;
    const rows = [];
    const targets = Array.isArray(indexes)
      ? indexes.map((index) => ({ index, segment: segments[index] })).filter((entry) => entry.segment)
      : segments.map((segment, index) => ({ index, segment }));
    targets.forEach(({ index, segment }) => {
      const before = String(segment.text ?? '');
      const matches = collectTextSearchMatchesWithRegex([before], compiled.regex);
      if (!matches.length) return;
      const after = replaceTextSearchMatchesInText(before, matches, replacement, options);
      matchCount += matches.length;
      if (after !== before) {
        rows.push({
          index,
          before,
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


  function compileTextSearchPattern(find, options = {}) {
    const source = String(find == null ? '' : find);
    if (!source) return { regex: null, error: null };
    const pattern = options.useRegex
      ? source
      : source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
      return {
        regex: new RegExp(pattern, `gu${options.caseSensitive ? '' : 'i'}`),
        error: null,
      };
    } catch (error) {
      return { regex: null, error: error?.message || String(error) };
    }
  }


  function advanceTextSearchIndex(source, index) {
    if (index >= source.length) return index + 1;
    const first = source.charCodeAt(index);
    if (first < 0xD800 || first > 0xDBFF || index + 1 >= source.length) return index + 1;
    const second = source.charCodeAt(index + 1);
    return second >= 0xDC00 && second <= 0xDFFF ? index + 2 : index + 1;
  }


  function collectTextSearchMatches(lines, find, options = {}) {
    const sourceLines = (Array.isArray(lines) ? lines : []).map((line) => String(line ?? ''));
    const compiled = compileTextSearchPattern(find, options);
    if (compiled.error) return { error: compiled.error, matches: [] };
    if (!compiled.regex) return { error: null, matches: [] };
    return { error: null, matches: collectTextSearchMatchesWithRegex(sourceLines, compiled.regex) };
  }


  function collectTextSearchMatchesWithRegex(lines, pattern) {
    const sourceLines = (Array.isArray(lines) ? lines : []).map((line) => String(line ?? ''));
    const matches = [];
    let globalOffset = 0;
    sourceLines.forEach((line, lineIndex) => {
      const regex = new RegExp(pattern.source, pattern.flags);
      let match;
      while ((match = regex.exec(line)) !== null) {
        matches.push({
          lineIndex,
          start: match.index,
          end: match.index + match[0].length,
          globalStart: globalOffset + match.index,
          globalEnd: globalOffset + match.index + match[0].length,
          text: match[0],
          captures: match.slice(1),
          groups: match.groups ? { ...match.groups } : null,
          matchIndex: matches.length,
        });
        if (match[0] === '') regex.lastIndex = advanceTextSearchIndex(line, regex.lastIndex);
      }
      globalOffset += line.length + (lineIndex + 1 < sourceLines.length ? 1 : 0);
    });
    return matches;
  }


  function expandTextSearchReplacement(template, match, line) {
    const source = String(template == null ? '' : template);
    const captures = Array.isArray(match?.captures) ? match.captures : [];
    const groups = match?.groups || null;
    return source.replace(/\$(\$|&|`|'|<([^>]*)>|(\d{1,2}))/g, (token, kind, groupName, digits) => {
      if (kind === '$') return '$';
      if (kind === '&') return match.text;
      if (kind === '`') return line.slice(0, match.start);
      if (kind === "'") return line.slice(match.end);
      if (groupName !== undefined) {
        if (!groups) return token;
        return Object.hasOwn(groups, groupName) ? String(groups[groupName] ?? '') : '';
      }
      const requested = String(digits || '');
      if (!requested) return token;
      const count = captures.length;
      const twoDigit = Number(requested);
      const oneDigit = Number(requested[0]);
      if (requested.length === 2 && twoDigit > 0 && twoDigit <= count) return String(captures[twoDigit - 1] ?? '');
      if (oneDigit > 0 && oneDigit <= count) {
        return `${String(captures[oneDigit - 1] ?? '')}${requested.slice(1)}`;
      }
      return token;
    });
  }


  function replaceTextSearchMatch(lines, match, replacement, options = {}) {
    const sourceLines = (Array.isArray(lines) ? lines : []).map((line) => String(line ?? ''));
    const line = sourceLines[match?.lineIndex];
    if (line == null || !Number.isInteger(match?.start) || !Number.isInteger(match?.end)) return sourceLines;
    const updated = replaceTextSearchMatchesInText(line, [{ ...match, lineIndex: 0 }], replacement, options);
    sourceLines.splice(match.lineIndex, 1, ...updated.replace(/\r\n?/g, '\n').split('\n'));
    return sourceLines;
  }


  function replaceTextSearchMatchesInText(text, matches, replacement, options = {}) {
    const source = String(text ?? '');
    const lineMatches = (Array.isArray(matches) ? matches : [])
      .filter((match) => match && (match.lineIndex === 0 || match.lineIndex == null)
        && Number.isInteger(match.start) && Number.isInteger(match.end)
        && match.start >= 0 && match.end >= match.start && match.end <= source.length)
      .sort((left, right) => left.start - right.start || left.end - right.end);
    let cursor = 0;
    let result = '';
    lineMatches.forEach((match) => {
      if (match.start < cursor) return;
      result += source.slice(cursor, match.start);
      result += options.useRegex
        ? expandTextSearchReplacement(replacement, match, source)
        : String(replacement == null ? '' : replacement);
      cursor = match.end;
    });
    return result + source.slice(cursor);
  }


  function replaceAllTextSearchMatches(lines, matches, replacement, options = {}) {
    const sourceLines = (Array.isArray(lines) ? lines : []).map((line) => String(line ?? ''));
    const matchesByLine = new Map();
    (Array.isArray(matches) ? matches : []).forEach((match) => {
      const group = matchesByLine.get(match.lineIndex) || [];
      group.push(match);
      matchesByLine.set(match.lineIndex, group);
    });
    const output = [];
    sourceLines.forEach((line, lineIndex) => {
      const lineMatches = matchesByLine.get(lineIndex) || [];
      if (!lineMatches.length) {
        output.push(line);
        return;
      }
      const result = replaceTextSearchMatchesInText(
        line,
        lineMatches.map((match) => ({ ...match, lineIndex: 0 })),
        replacement,
        options,
      );
      output.push(...result.replace(/\r\n?/g, '\n').split('\n'));
    });
    return output;
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


  const CHINESE_DIGITS = Object.freeze({
    零: '0', 〇: '0', 一: '1', 二: '2', 两: '2', 三: '3', 四: '4',
    五: '5', 六: '6', 七: '7', 八: '8', 九: '9',
  });
  const CHINESE_SMALL_UNITS = Object.freeze({ 十: 10, 百: 100, 千: 1000 });
  const CHINESE_LARGE_UNITS = Object.freeze({ 万: 10000, 亿: 100000000 });
  const CHINESE_NUMBER_PATTERN = /负?[零〇一二两三四五六七八九十百千万亿点]+/gu;
  const CHINESE_NUMBER_IDIOMS = Object.freeze([
    '一心一意', '一举两得', '三心二意', '三三两两', '四面八方', '五颜六色', '七上八下',
    '九牛一毛', '十全十美', '一清二楚', '一模一样', '一五一十', '一言为定', '一日三餐',
    '十有八九', '百里挑一', '一了百了', '一朝一夕', '一穷二白', '一呼百应', '一成不变',
    '一鸣惊人', '二话不说', '两全其美', '三长两短', '三姑六婆', '三番五次', '五花八门',
    '六神无主', '七嘴八舌', '八面玲珑', '九死一生', '九霄云外', '十拿九稳', '百发百中',
    '百战百胜', '千篇一律', '千辛万苦', '千方百计', '千千万万', '万万没想到', '八九不离十',
  ]);
  const CHINESE_MEASURE_SUFFIXES = Object.freeze([
    '个', '条', '只', '次', '分', '秒', '年', '月', '日', '天', '小时', '分钟', '秒钟',
    '句', '字', '块', '段', '张', '位', '名', '层', '页', '集', '首', '章', '种', '款',
    '岁', '人', '件', '本', '家', '场', '遍', '轮', '点', '度', '米', '公里', '元', '块钱',
  ]);


  function chineseDigitSequence(text) {
    const chars = Array.from(String(text || ''));
    if (!chars.length || !chars.every((char) => Object.hasOwn(CHINESE_DIGITS, char))) return null;
    return chars.map((char) => CHINESE_DIGITS[char]).join('');
  }


  function parseChineseInteger(text) {
    const source = String(text || '');
    const digitSequence = chineseDigitSequence(source);
    if (digitSequence !== null) return digitSequence;

    let total = 0;
    let section = 0;
    let number = 0;
    let hasPendingDigit = false;
    let previousSmallUnit = Infinity;
    let previousLargeUnit = Infinity;
    for (const char of Array.from(source)) {
      if (char === '零' || char === '〇') {
        number = 0;
        hasPendingDigit = false;
        previousSmallUnit = Infinity;
        continue;
      }
      if (Object.hasOwn(CHINESE_DIGITS, char)) {
        if (hasPendingDigit) return null;
        number = Number(CHINESE_DIGITS[char]);
        hasPendingDigit = true;
        continue;
      }
      if (Object.hasOwn(CHINESE_SMALL_UNITS, char)) {
        const unit = CHINESE_SMALL_UNITS[char];
        if (unit >= previousSmallUnit) return null;
        if (!hasPendingDigit) {
          if (unit !== 10 || section !== 0) return null;
          number = 1;
        }
        section += number * unit;
        number = 0;
        hasPendingDigit = false;
        previousSmallUnit = unit;
        continue;
      }
      if (Object.hasOwn(CHINESE_LARGE_UNITS, char)) {
        const unit = CHINESE_LARGE_UNITS[char];
        if (unit >= previousLargeUnit) return null;
        const group = section + number;
        if (group === 0) return null;
        total += group * unit;
        section = 0;
        number = 0;
        hasPendingDigit = false;
        previousSmallUnit = Infinity;
        previousLargeUnit = unit;
        continue;
      }
      return null;
    }
    const value = total + section + number;
    if (!Number.isSafeInteger(value)) return null;
    return String(value);
  }


  function parseChineseNumber(text) {
    let source = String(text || '');
    let sign = '';
    if (source.startsWith('负')) {
      sign = '-';
      source = source.slice(1);
    }
    if (!source) return null;
    const decimalParts = source.split('点');
    if (decimalParts.length > 2) return null;
    const whole = parseChineseInteger(decimalParts[0] || '零');
    if (whole === null) return null;
    if (decimalParts.length === 1) return `${sign}${whole}`;
    const fraction = chineseDigitSequence(decimalParts[1]);
    if (fraction === null || !fraction) return null;
    return `${sign}${whole}.${fraction}`;
  }


  function isChineseNumberAmbiguous(source, start, end, matched) {
    const previous = source.slice(Math.max(0, start - 4), start);
    const next = source.slice(end, end + 3);
    if (previous.endsWith('百分之') || previous.endsWith('分之') || next.startsWith('分之')) return true;
    // Adjacent digits usually express an approximate quantity (「两三」「三两」),
    // not a positional digit sequence. Keep them even without a measure word.
    if (/^负?(?:一[二两]|[二两]三|三[两四]|四五|五六|六七|七八|八九)(?:点[零〇一二两三四五六七八九]+)?$/u.test(matched)) return true;
    // 「一万一」「十几」「一百八」等口语缩略存在多种数值解释，保持原文。
    if (/[万亿][零〇一二两三四五六七八九]$/u.test(matched)) return true;
    if (/[百千][一二两三四五六七八九]$/u.test(matched)) return true;
    if (/[多余来几上下左右]/u.test(Array.from(next)[0] || '')) return true;
    return false;
  }


  function isStandaloneSingleDigit(source, start, end, matched) {
    const core = matched.startsWith('负') ? matched.slice(1) : matched;
    if (Array.from(core).length !== 1) return true;
    const before = source.slice(0, start);
    const after = source.slice(end);
    const nextChars = Array.from(after);
    const next = nextChars.slice(0, 3).join('');
    if (!before.trim() && !after.trim()) return true;
    if (before.endsWith('第')) return true;
    return CHINESE_MEASURE_SUFFIXES.some((suffix) => next.startsWith(suffix));
  }


  function convertChineseNumbers(text) {
    const source = String(text == null ? '' : text);
    const idiomRanges = [];
    CHINESE_NUMBER_IDIOMS.forEach((idiom) => {
      let cursor = 0;
      while ((cursor = source.indexOf(idiom, cursor)) >= 0) {
        idiomRanges.push([cursor, cursor + idiom.length]);
        cursor += idiom.length;
      }
    });
    CHINESE_NUMBER_PATTERN.lastIndex = 0;
    return source.replace(CHINESE_NUMBER_PATTERN, (matched, offset) => {
      const start = Number(offset);
      const end = start + matched.length;
      if (idiomRanges.some(([left, right]) => start < right && end > left)) return matched;
      if (isChineseNumberAmbiguous(source, start, end, matched)
          || !isStandaloneSingleDigit(source, start, end, matched)) return matched;
      const converted = parseChineseNumber(matched);
      return converted === null ? matched : ` ${converted} `;
    });
  }


  // Preview and apply share this order: Markdown -> trim -> capitalization ->
  // number conversion -> character wrapping. Legacy prefix/suffix options stay
  // supported for existing integrations, but the editor now uses wrapLeft/right.
  function applyTextProcessing(text, options = {}) {
    let result = String(text == null ? '' : text);
    if (options.stripMarkdown) result = stripMarkdownFormatting(result);
    if (options.trim) result = result.trim();
    if (options.capitalize) result = capitalizeFirstLetter(result);
    if (options.convertChineseNumbers) result = convertChineseNumbers(result);
    if (options.addWrapChars) {
      const left = String(options.wrapLeft == null ? '' : options.wrapLeft);
      const right = String(options.wrapRight == null ? '' : options.wrapRight);
      const wrapped = Array.isArray(options.wrapPairs)
        ? wrapTextWithPairs(result, options.wrapPairs, options.skipWrapped)
        : wrapPreservingSentenceShells(result, left, right, options.skipWrapped);
      result = wrapped.text;
    }
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
    const parsed = sentenceShells(source, rule);
    const fades = parsed.shells.filter(shell => shell.kind === 'fade');
    return { text: rebuildShells(parsed.body, parsed.shells.filter(shell => shell.kind !== 'fade')),
      fadeIn: fades.some(shell => Boolean(shell.left)), fadeOut: fades.some(shell => Boolean(shell.right)) };
  }


  function stripSentenceFadeMarkers(text, rule) {
    return parseSentenceFadeMarkers(text, rule).text;
  }


  // ASS 单句原地震动标记：整行两端各写 `!!` 表示该句导出时按固定间隔拆分
  // 为多条 \pos 抖动事件（见 ass-canvas-layout 的震动参数）。仅识别双符号，
  // 没有单双规则；至少要有一个字符的正文才视为标记。整句字号、淡入淡出
  // 与震动可以按任意嵌套顺序组合，剥除效果标记时保留其余外层格式。
  function parseSentenceShakeMarkers(text) {
    const source = String(text == null ? '' : text);
    const parsed = sentenceShells(source);
    return { text: rebuildShells(parsed.body, parsed.shells.filter(shell => shell.kind !== 'shake')),
      shake: parsed.shells.some(shell => shell.kind === 'shake') };
  }

  // Peel only complete sentence shells. Inline runs in a mixed sentence are
  // not shells and cannot turn an inner !! into a sentence effect.
  function sentenceShells(text, rule) {
    let body = String(text ?? '');
    const shells = [];
    const formats = ['++', '--', '**', '__', '~~', '//'];
    while (body) {
      const token = ['!!', ...formats].find(token => body.length > token.length * 2
        && body.startsWith(token) && body.endsWith(token)
        && (token === '!!' || !body.slice(token.length, -token.length).includes(token)));
      if (token) {
        shells.push({ kind: token === '!!' ? 'shake' : 'format', left: token, right: token });
        body = body.slice(token.length, -token.length);
        continue;
      }
      const single = rule === 'both' || rule === 'single';
      const left = body.startsWith('>>') ? '>>' : single && body.startsWith('>') ? '>' : '';
      const right = body.endsWith('<<') ? '<<' : single && body.endsWith('<') ? '<' : '';
      if (!left && !right) break;
      // A repeated fade pair is literal after the first pair, matching SRT's
      // existing parse-once contract (>>>>text<<<< retains >>text<<).
      if (shells.some(shell => shell.kind === 'fade')) break;
      shells.push({ kind: 'fade', left, right });
      body = body.slice(left.length, right ? -right.length : undefined);
    }
    return { body, shells };
  }

  function rebuildShells(body, shells) {
    return shells.reduceRight((text, shell) => `${shell.left}${text}${shell.right}`, body);
  }

  // Preserve existing sentence effects while nesting the selected wrappers in click order.
  // Reuse selected shells instead of doubling an already present individual style.
  function wrapTextWithPairs(source, pairs, skipWrapped) {
    const wraps = pairs.map(({ left, right }) => ({ left: String(left ?? ''), right: String(right ?? '') }))
      .filter(({ left, right }) => left || right);
    if (!wraps.length || !source) return { text: source, skipped: false };
    const parsed = sentenceShells(source);
    const selected = (shell) => wraps.some((wrap) => wrap.left === shell.left && wrap.right === shell.right);
    const retained = skipWrapped ? parsed.shells.filter((shell) => !selected(shell)) : parsed.shells;
    let body = parsed.body;
    // Custom/common pairs are not ASS sentence shells but may already wrap the body.
    if (skipWrapped) {
      const remaining = [...wraps];
      while (remaining.length) {
        const index = remaining.findIndex(({ left, right }) => isTextWrappedBy(body, left, right));
        if (index < 0) break;
        const [{ left, right }] = remaining.splice(index, 1);
        body = body.slice(left.length, -right.length);
      }
    }
    return { text: rebuildShells(rebuildShells(body, wraps), retained), skipped: false };
  }

  function wrapPreservingSentenceShells(source, left, right, skipWrapped) {
    const parsed = sentenceShells(source);
    const skipped = skipWrapped && (isTextWrappedBy(source, left, right)
      || parsed.shells.some(shell => shell.left === left && shell.right === right)
      || isTextWrappedBy(parsed.body, left, right));
    return { skipped: Boolean(skipped), text: skipped ? source
      : rebuildShells(`${left}${parsed.body}${right}`, parsed.shells) };
  }


  function stripSentenceShakeMarkers(text) {
    return parseSentenceShakeMarkers(text).text;
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
    { id: 'shake', label: '原地震动', left: '!!', right: '!!', ass: true },
    { id: 'comment', label: '注释文本', left: '//', right: '//', ass: true },
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
    const result = wrapPreservingSentenceShells(source, l, r, true);
    return { changed: result.text !== source, ...result };
  }


  return Object.freeze({
    applyTextProcessing,
    buildReplacementPreview,
    compileTextSearchPattern,
    collectTextSearchMatches,
    replaceTextSearchMatch,
    replaceAllTextSearchMatches,
    replaceTextSearchMatchesInText,
    expandTextSearchReplacement,
    buildTextProcessingPreview,
    parseSentenceFadeMarkers,
    stripSentenceFadeMarkers,
    parseSentenceShakeMarkers,
    stripSentenceShakeMarkers,
    convertChineseNumbers,
    WRAP_CHAR_PRESETS,
    isTextWrappedBy,
    wrapCharsAroundText,
  });
}
