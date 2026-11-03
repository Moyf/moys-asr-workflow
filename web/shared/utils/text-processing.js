// text-processing: private helpers; dependencies are injected by editor-utils.js.
export function createUtilsModule(dependencies) {
  'use strict';
  const { assMarkedRanges } = dependencies;


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
        ? wrapTextWithPairs(result, options.wrapPairs, options.skipWrapped, options.assSpecialSymbolRule ?? 'both')
        : wrapPreservingSentenceShells(result, left, right, options.skipWrapped, options.assSpecialSymbolRule ?? 'both');
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


  // ASS 单句放大出现标记：整行两端各写 `{{` `}}` 表示该句以「从大缩小落定」
  // 的入场动画出现（参数取自样式库 profile 的 pop 组，不管其全局开关；与
  // 单句 fade 复用 fad 参数同一模式）。仅识别双符号；至少要有一个字符的
  // 正文才视为标记。句级标记之间可按任意嵌套顺序组合。
  function parseSentencePopMarkers(text, rule) {
    const source = String(text == null ? '' : text);
    if (rule === 'none') return { text: source, pop: false };
    const parsed = sentenceShells(source, rule);
    return { text: rebuildShells(parsed.body, parsed.shells.filter(shell => shell.kind !== 'pop')),
      pop: parsed.shells.some(shell => shell.kind === 'pop') };
  }


  function stripSentencePopMarkers(text, rule) {
    return parseSentencePopMarkers(text, rule).text;
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
    const formats = ['++', '--', '**', '__', '~~', '//', '%%'];
    while (body) {
      // `{{…}}` 是不对称句级壳：行首 `{{` 与行尾 `}}` 配对（同 fade 的行首/
      // 行尾语义），其余 token 两侧同符号；内层再出现 `{{` 视为字面。
      if (body.length > 4 && body.startsWith('{{') && body.endsWith('}}')
        && !body.slice(2, -2).includes('{{')) {
        shells.push({ kind: 'pop', left: '{{', right: '}}' });
        body = body.slice(2, -2);
        continue;
      }
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

  // 句级效果符号对（淡出淡入 / 原地震动 / 放大出现）：ASS 只在整句两端识别
  // 它们，因此插入时必须包裹在现有全部符号最外层，否则样式失效。
  // 成对才视为句级壳（见 sentenceShells 的剥离条件），孤儿字面保持不动。
  const SENTENCE_LEVEL_WRAP_PAIRS = Object.freeze([
    ['>>', '<<'],
    ['!!', '!!'],
    ['{{', '}}'],
  ]);

  function isSentenceLevelWrapPair(left, right) {
    return SENTENCE_LEVEL_WRAP_PAIRS.some(([l, r]) => l === left && r === right);
  }

  // Preserve existing sentence effects while nesting the selected wrappers in click order.
  // Reuse selected shells instead of doubling an already present individual style.
  // 句级对（fade/shake）恒重建在现有句级壳之外（最新最外，与单对路径一致），
  // 行内对落回现有壳之内——分层规则与 wrapPreservingSentenceShells 相同。
  function wrapTextWithPairs(source, pairs, skipWrapped, rule) {
    const wraps = pairs.map(({ left, right }) => ({ left: String(left ?? ''), right: String(right ?? '') }))
      .filter(({ left, right }) => left || right);
    if (!wraps.length || !source) return { text: source, skipped: false };
    const parsed = sentenceShells(source, rule);
    const fade = parsed.shells.find(shell => shell.kind === 'fade');
    const addsFade = wraps.some(({ left, right }) => left === '>>' && right === '<<');
    const selected = (shell) => wraps.some((wrap) => wrap.left === shell.left && wrap.right === shell.right);
    const retained = parsed.shells.filter(shell => !(addsFade && shell.kind === 'fade')
      && (!skipWrapped || !selected(shell)));
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
    const sentenceWraps = wraps.filter(({ left, right }) => isSentenceLevelWrapPair(left, right))
      .map(wrap => fade && wrap.left === '>>' && wrap.right === '<<'
        ? { left: fade.left || wrap.left, right: fade.right || wrap.right } : wrap);
    const inlineWraps = wraps.filter(({ left, right }) => !isSentenceLevelWrapPair(left, right));
    return { text: rebuildShells(rebuildShells(rebuildShells(body, inlineWraps), retained), sentenceWraps), skipped: false };
  }

  function wrapPreservingSentenceShells(source, left, right, skipWrapped, rule) {
    const parsed = sentenceShells(source, rule);
    const skipped = skipWrapped && (isTextWrappedBy(source, left, right)
      || parsed.shells.some(shell => shell.left === left && shell.right === right)
      || isTextWrappedBy(parsed.body, left, right));
    if (skipped) return { skipped: true, text: source };
    if (left === '>>' && right === '<<') {
      const fade = parsed.shells.find(shell => shell.kind === 'fade');
      if (fade) {
        const text = rebuildShells(parsed.body, parsed.shells.map(shell => shell === fade
          ? { ...shell, left: shell.left || left, right: shell.right || right } : shell));
        return { skipped: skipWrapped && text === source, text };
      }
    }
    // 句级预设恒包裹在最外层（先重建现有壳，再用句级对包住；重复应用同一
    // 句级对已在上方跳过）。行内预设维持现行行为：包住剥壳后的正文，重建时
    // 落回现有符号（含句级壳）之内。
    if (isSentenceLevelWrapPair(left, right)) {
      return { skipped: false, text: `${left}${rebuildShells(parsed.body, parsed.shells)}${right}` };
    }
    return { skipped: false, text: rebuildShells(`${left}${parsed.body}${right}`, parsed.shells) };
  }


  function stripSentenceShakeMarkers(text) {
    return parseSentenceShakeMarkers(text).text;
  }


  // === MASS（Markdown-ASS）成对标记 ===
  // 权威清单 = WRAP_CHAR_PRESETS 中 ass:true 的 9 对（** ++ -- __ ~~ >>…<< !! // %%）。
  // 行内同符号对（** ++ -- __ ~~ // %% !!）复用 assMarkedRanges 的配对语义，
  // 找不到成对的孤儿符号一律按字面保留；句级 fade >>…<< 是非对称标记，
  // 单独按 parseSentenceFadeMarkers 的行首/行尾语义处理，不进 assMarkedRanges。
  // rule 与「特殊文本规则」设置（assSpecialSymbolRule）同源：
  // none 不识别任何符号；double 只识别双符号；both / single（含缺省）识别单双。
  function massSymbolWidths(rule) {
    return rule === 'none' ? [] : rule === 'double' ? [2] : [1, 2];
  }


  // 收集文本里全部 MASS 成对区间（UTF-16 下标，与 assMarkedRanges 一致），
  // 附带 marker 字符串供补齐/折叠使用；按出现顺序排序。rule none 时全量
  // 不识别（与 assMarkedRuns 的特殊文本规则语义一致）。
  function massMarkedRanges(source, rule) {
    if (rule === 'none') return [];
    const text = String(source ?? '');
    const ranges = [];
    massSymbolWidths(rule).forEach((width) => {
      ['*', '_', '+', '-', '~'].forEach((symbol) => {
        const marker = symbol.repeat(width);
        assMarkedRanges(text, marker).forEach((range) => {
          ranges.push({ ...range, marker });
        });
      });
    });
    ['//', '%%', '!!'].forEach((marker) => {
      assMarkedRanges(text, marker).forEach((range) => {
        ranges.push({ ...range, marker });
      });
    });
    return ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  }


  // 剥离成对 MASS 符号、保留正文；孤儿符号维持字面。供 SRT/TXT 等纯文本
  // 导出使用；句级 fade/shake 仍由 stripSentenceFade/ShakeMarkers 负责（先行
  // 剥离），这里只处理剩余的行内成对符号，两者不会互相重复或破坏。
  function stripMassMarkers(text, rule) {
    const source = String(text ?? '');
    const cuts = [];
    massMarkedRanges(source, rule).forEach(({ start, end, width }) => {
      cuts.push([start, start + width], [end, end + width]);
    });
    if (!cuts.length) return source;
    cuts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let result = '';
    let cursor = 0;
    for (const [from, to] of cuts) {
      if (from < cursor) continue;
      result += source.slice(cursor, from);
      cursor = Math.max(cursor, to);
    }
    return result + source.slice(cursor);
  }


  // 整行句级 fade 外壳（>>…<<，含单双规则的单符号形式）；没有完整对时返回 null。
  function fadeShellPair(text, rule) {
    if (rule === 'none') return null;
    const source = String(text ?? '');
    const single = rule === 'both' || rule === 'single';
    const open = source.startsWith('>>') ? '>>' : single && source.startsWith('>') ? '>' : '';
    const close = source.endsWith('<<') ? '<<' : single && source.endsWith('<') ? '<' : '';
    if (!open || !close || source.length <= open.length + close.length) return null;
    return { open, close };
  }


  // 整行句级 shake 外壳（!!…!!，仅双符号、不区分单双规则，与
  // parseSentenceShakeMarkers 的识别范围一致）；没有完整对时返回 null。
  function shakeShellPair(text) {
    const source = String(text ?? '');
    return source.length > 4 && source.startsWith('!!') && source.endsWith('!!')
      ? { open: '!!', close: '!!' }
      : null;
  }


  // 行内 `{{…}}` pop 对区间（仅双符号、不对称：`{{` 开 `}}` 闭，下标约定与
  // massMarkedRanges 一致——正文夹在 start+width 与 end 之间）。供拆分补齐
  // 定位跨刀点 pop 对使用；位置不限（可嵌在 `!!` 等外层壳内），from 之后
  // 找不到完整对时返回 null。
  function popMarkedRange(text, from = 0) {
    const source = String(text ?? '');
    const start = source.indexOf('{{', from);
    if (start < 0) return null;
    const end = source.indexOf('}}', start + 2);
    if (end < 0) return null;
    return { start, end, width: 2 };
  }


  // 整行句级 pop 外壳（{{…}}，不对称——行首 `{{` 与行尾 `}}` 配对，内层
  // 再出现 `{{` 视为字面，与 parseSentencePopMarkers 的识别范围一致）；
  // 没有完整外壳时返回 null。
  function popShellPair(text) {
    const source = String(text ?? '');
    return source.length > 4 && source.startsWith('{{') && source.endsWith('}}')
      && !source.slice(2, -2).includes('{{')
      ? { open: '{{', close: '}}' }
      : null;
  }


  // 句级壳位置过滤：pop 对只有在「外层壳开符号序列 + pop + 逆序闭符号序列」
  // 里才算真标记（与 sentenceShells 的整句壳识别一致——fade 双/单符号按
  // rule，`!!` 与六个双符号格式只认双写）。行内其他位置的 `{{…}}` 是字面，
  // 拆分补齐不能碰：补了会把字面括号复制成可见文本。不是壳位置返回 null。
  function popShellPositionRange(text, rule) {
    const source = String(text ?? '');
    const range = popMarkedRange(source);
    if (!range || rule === 'none' || source.slice(range.start + 2, range.end).includes('{{')) return null;
    const pairs = [['>>', '<<']];
    if (rule === 'both' || rule === 'single') pairs.push(['>', '<']);
    pairs.push(['!!', '!!'], ['{{', '}}']);
    ['++', '--', '**', '__', '~~', '//', '%%'].forEach(marker => pairs.push([marker, marker]));
    let prefix = source.slice(0, range.start);
    let suffix = source.slice(range.end + range.width);
    const opens = [];
    while (prefix) {
      const pair = pairs.find(([open]) => prefix.startsWith(open));
      if (!pair) return null;
      opens.push(pair);
      prefix = prefix.slice(pair[0].length);
    }
    while (opens.length) {
      const close = opens.pop()[1];
      if (!suffix.startsWith(close)) return null;
      suffix = suffix.slice(close.length);
    }
    return suffix ? null : range;
  }


  // 拆分补齐（维护者拍板方案 2）：拆开后若某个 MASS 符号对的开口/闭口分处
  // 两侧片段，两侧各补齐成对——文本层加符号，leftAppend / rightPrepend 返回
  // 需要同步补进边界 item 的符号串。fade >>…<< 句级外壳与行内同符号对一起
  // 收集（账本 #19①：>>!!这样的｜文字!!<< 两侧都补齐 → >>!!这样的!!<< /
  // >>!!文字!!<<）；左侧补闭符号按原文闭符号顺序（嵌套逆序、内层先闭），
  // 右侧补开符号按原文开符号顺序。只补「该侧还有正文」的对（刀点恰在符号
  // 端点时该侧维持孤儿字面），并复验补齐结果确实按同规则成对，失败即回退
  // 为字面，不产生第三个符号。
  function completeSplitMassPairs(leftText, rightText, rule) {
    const left = String(leftText ?? '');
    const right = String(rightText ?? '');
    const combined = left + right;
    const cut = left.length;
    if (!combined) return { left, right, leftAppend: '', rightPrepend: '' };
    // 收集所有跨拆分点的对：行内同符号对 + 整行句级 fade 外壳。
    const straddling = massMarkedRanges(combined, rule)
      .filter(({ start, end, width }) => start < cut && end + width > cut)
      .map(({ start, end, width, marker }) => ({ kind: 'inline', start, end, width, marker, closeMarker: marker }));
    const fade = fadeShellPair(combined, rule);
    if (fade && cut > fade.open.length && cut < combined.length - fade.close.length) {
      straddling.push({
        kind: 'fade', start: 0, end: combined.length - fade.close.length,
        width: fade.open.length, marker: fade.open, closeMarker: fade.close,
      });
    }
    // pop 对须处于句级壳位置（行首或嵌在外层壳开符号序列内，与
    // parseSentencePopMarkers 的识别范围一致），且刀点落在正文内——恰在
    // 符号端点时该侧维持孤儿字面（与 fade 的端点守卫同一约定）。
    const pop = popShellPositionRange(combined, rule);
    if (pop && pop.start + pop.width < cut && cut < pop.end) {
      straddling.push({ kind: 'pop', ...pop, marker: '{{', closeMarker: '}}' });
    }
    const verifyLeft = (candidate, range) => (range.kind === 'fade'
      ? (() => {
        const check = parseSentenceFadeMarkers(candidate, rule);
        return check.fadeIn && check.fadeOut;
      })()
      : range.kind === 'pop'
        ? (() => {
          // `{{`/`}}` 是不对称对，assMarkedRanges（同符号配对）扫不到，
          // 用 popMarkedRange 按位置复验：补上的 `}}` 须与原文 `{{` 恰好
          // 收在候选片段末尾。
          const paired = popMarkedRange(candidate);
          return Boolean(paired) && paired.start === range.start
            && paired.end + paired.width === candidate.length;
        })()
      : assMarkedRanges(candidate, range.marker)
        .some((paired) => paired.start === range.start && paired.end + paired.width === candidate.length));
    const verifyRight = (candidate, range) => (range.kind === 'fade'
      ? (() => {
        const check = parseSentenceFadeMarkers(candidate, rule);
        return check.fadeIn && check.fadeOut;
      })()
      : range.kind === 'pop'
        ? (() => {
          const paired = popMarkedRange(candidate);
          return Boolean(paired) && paired.start === range.prependAt
            && paired.end === range.prependAt + range.width + range.end - cut;
        })()
      : assMarkedRanges(candidate, range.marker)
        .some((paired) => paired.start === range.prependAt
          && paired.end === range.prependAt + range.width + range.end - cut));
    let leftAppend = '';
    // fade 已完整守卫（分层体系）：splitStyledTextParts 已对两侧整句包裹时，
    // 组合文本仍会判出跨刀点 fade 对，但左/右其实各自已有完整外壳——再补就
    // 双重包裹。左已有闭（fadeOut）不补闭，右已有开（fadeIn）不补开。
    const leftFadeComplete = parseSentenceFadeMarkers(left, rule).fadeOut;
    // pop 同理：该侧已剥出完整 pop 壳就不重复补（pop 只认双符号，无单双规则）。
    const leftPopComplete = parseSentencePopMarkers(left, rule).pop;
    // 左侧补闭符号：按原文闭符号位置升序 = 嵌套逆序（内层先闭）。
    straddling.slice().sort((a, b) => a.end - b.end).forEach((range) => {
      if (range.start + range.width >= cut) return;
      if (range.kind === 'fade' && leftFadeComplete) return;
      if (range.kind === 'pop' && leftPopComplete) return;
      const candidate = left + leftAppend + range.closeMarker;
      if (verifyLeft(candidate, range)) leftAppend += range.closeMarker;
    });
    let rightPrepend = '';
    const rightFadeStarted = parseSentenceFadeMarkers(right, rule).fadeIn;
    const rightPopStarted = parseSentencePopMarkers(right, rule).pop;
    // 右侧补开符号：按原文开符号位置升序（外层在前）。
    straddling.slice().sort((a, b) => a.start - b.start).forEach((range) => {
      if (range.end <= cut) return;
      if (range.kind === 'fade' && rightFadeStarted) return;
      if (range.kind === 'pop' && rightPopStarted) return;
      const prependAt = rightPrepend.length;
      const candidate = `${rightPrepend}${range.marker}${right}`;
      if (verifyRight(candidate, { ...range, prependAt })) rightPrepend += range.marker;
    });
    // 返回补齐后的两侧文本；leftAppend / rightPrepend 供 items 层同步补符号。
    return {
      left: left + leftAppend,
      right: rightPrepend + right,
      leftAppend,
      rightPrepend,
    };
  }


  // 拆分/转换产物的 items 层符号补位（共享实现，split-core 与各转换出口共用）：
  // 文本层补在两侧端点的 MASS 符号，对应挂到边界 item 的文本末尾/开头（与
  // 「中性字符挂靠前一发音 item / 行首归第一 item」的归属规则一致），保证
  // items 拼接 == 其文本。
  function appendMassMarkersToLastItem(items, markers) {
    if (!markers || !Array.isArray(items) || !items.length) return items;
    const last = items[items.length - 1];
    items[items.length - 1] = { ...last, text: `${String(last?.text || '')}${markers}` };
    return items;
  }

  function prependMassMarkersToFirstItem(items, markers) {
    if (!markers || !Array.isArray(items) || !items.length) return items;
    const first = items[0];
    items[0] = { ...first, text: `${markers}${String(first?.text || '')}` };
    return items;
  }

  // Split against the whole remaining phrase so pairs spanning three or more
  // rows remain visible at every cut. Callers supply rows from one source only.
  function completeMassTextRows(rows, rule) {
    if (!rule || rule === 'none' || rows.length < 2) return rows;
    let remaining = rows.map(row => String(row.text || '')).join('');
    for (let index = 0; index < rows.length - 1; index += 1) {
      const current = rows[index];
      remaining = remaining.slice(current.text.length);
      const completed = completeSplitMassPairs(current.text, remaining, rule);
      current.text = completed.left;
      appendMassMarkersToLastItem(current.items, completed.leftAppend);
      rows[index + 1].text = completed.rightPrepend + rows[index + 1].text;
      prependMassMarkersToFirstItem(rows[index + 1].items, completed.rightPrepend);
      remaining = completed.right;
    }
    return rows;
  }


  // 合并折叠：前段以「已识别对的闭符号」结尾、后段以同符号的开符号开头时，
  // 优先整体折叠——前段尾闭与后段首开一并移除，两段内容合成一个跨 junction
  // 的完整对（样式取两段并集、无孤儿符号、拆分-合并往返无损；复验重 union
  // 失败则退回仅移后段开符号）。fade / shake 句级外壳按整句壳折叠：两侧各
  // 是完整外壳时合并回一个覆盖整句的外壳，复验走句级 parse-once 解析。
  // 不构成折叠时返回 null。
  // joiner 是 junction 处的分隔符（单词型合并的空格等）：重 union 复验按
  // 「左段 + joiner + 右段」拼回的最终文本判定，折叠后由调用方把 joiner
  // 插回两段之间。
  // leftTrimmed 是前段尾部被裁掉的字符数，供 items 层同步。
  function foldMassPairJunction(leftText, rightText, rule, joiner = '') {
    const left = String(leftText ?? '');
    const right = String(rightText ?? '');
    const join = String(joiner ?? '');
    if (!left || !right) return null;
    const leftFade = fadeShellPair(left, rule);
    const rightFade = fadeShellPair(right, rule);
    if (leftFade && rightFade) {
      const trimmedLeft = left.slice(0, left.length - leftFade.close.length);
      const trimmedRight = right.slice(rightFade.open.length);
      const check = parseSentenceFadeMarkers(trimmedLeft + join + trimmedRight, rule);
      if (check.fadeIn && check.fadeOut) {
        return {
          left: trimmedLeft, right: trimmedRight,
          removed: rightFade.open.length, leftTrimmed: leftFade.close.length,
        };
      }
    }
    const leftShake = shakeShellPair(left);
    const rightShake = shakeShellPair(right);
    if (leftShake && rightShake) {
      const trimmedLeft = left.slice(0, left.length - leftShake.close.length);
      const trimmedRight = right.slice(rightShake.open.length);
      const check = parseSentenceShakeMarkers(trimmedLeft + join + trimmedRight);
      if (check.shake) {
        return {
          left: trimmedLeft, right: trimmedRight,
          removed: rightShake.open.length, leftTrimmed: leftShake.close.length,
        };
      }
    }
    const leftPop = rule === 'none' ? null : popShellPair(left);
    const rightPop = popShellPair(right);
    if (leftPop && rightPop) {
      const trimmedLeft = left.slice(0, left.length - leftPop.close.length);
      const trimmedRight = right.slice(rightPop.open.length);
      const check = parseSentencePopMarkers(trimmedLeft + join + trimmedRight, rule);
      if (check.pop) {
        return {
          left: trimmedLeft, right: trimmedRight,
          removed: rightPop.open.length, leftTrimmed: leftPop.close.length,
        };
      }
    }
    const markers = [];
    massSymbolWidths(rule).forEach((width) => {
      ['*', '_', '+', '-', '~'].forEach((symbol) => markers.push(symbol.repeat(width)));
    });
    // `!!` 是整句壳（SENTENCE_LEVEL_WRAP_PAIRS），只走上面的句级折叠；
    // 行内形式的 `!!` 不跨 junction 折叠——折出来也是句中死标记。
    // `//` 斜体与 `%%` 弱化是固定双符号行内对，同样参与 junction 折叠。
    markers.push('//');
    markers.push('%%');
    // 双符号是「左右添加字符」预设的规范形式，优先判定。
    markers.sort((a, b) => b.length - a.length);
    for (const marker of markers) {
      const width = marker.length;
      if (!left.endsWith(marker) || !right.startsWith(marker)) continue;
      const closePair = assMarkedRanges(left, marker)
        .find((range) => range.end + range.width === left.length);
      const openPair = assMarkedRanges(right, marker).find((range) => range.start === 0);
      if (!closePair || !openPair) continue;
      // 优先整体折叠（前段尾闭 + 后段首开一并移除）：两段的符号本就是同一
      // 语法对被拆分补齐/独立包裹拆成的两侧，合并时还原为一个跨 junction 的
      // 完整对——样式取两段并集、不残留孤儿符号，拆分-合并往返无损。
      // （Greptile P1：只移后段开符号会留前段尾闭孤儿 `**甲**乙**`。）
      const rejoined = left.slice(0, left.length - width) + join + right.slice(width);
      const rejoinedCloseAt = left.length - width + join.length + (openPair.end - width);
      const reunited = assMarkedRanges(rejoined, marker).some((range) => (
        range.start === closePair.start && range.end === rejoinedCloseAt
      ));
      if (reunited) {
        return {
          left: left.slice(0, left.length - width),
          right: right.slice(width),
          removed: width, leftTrimmed: width,
        };
      }
      // 复验失败（重 union 不成立，如中间插了别的符号干扰解析）时退回仅移
      // 后段开符号，前段尾闭保留防误解析。
      return { left, right: right.slice(width), removed: width, leftTrimmed: 0 };
    }
    return null;
  }


  // 三处合并路径（主/副/overlay）共用的「拼接 + 相邻同符号对折叠」：无论有
  // 无分隔符都在 junction 折叠「前段尾闭 + 后段首开」的同符号对——无分隔符
  // 时防止符号连跑（`****`），有分隔符（单词型的空格等）时还原被拆分补齐
  // 拆开的完整对（`!!This is a!!` + `!!short test video!!` →
  // `!!This is a short test video!!`）；折叠后分隔符插回 junction，items 层
  // 同步裁掉被折叠的符号、并把分隔符归位到后段首个存活 item 的开头，
  // 保证每段 items 拼接 == 其文本的守恒契约随文本一起成立。
  function joinSegmentTextsMassFold(segments, separator, rule) {
    const source = Array.isArray(segments) ? segments : [];
    const texts = source.map((segment) => String(segment?.text || ''));
    const leadingSlices = source.map(() => 0);
    const trailingSlices = source.map(() => 0);
    let text = texts[0] || '';
    for (let index = 1; index < texts.length; index += 1) {
      let part = texts[index];
      if (text && part) {
        const folded = foldMassPairJunction(text, part, rule, separator);
        if (folded) {
          text = folded.left;
          part = folded.right;
          leadingSlices[index] = folded.removed;
          trailingSlices[index - 1] = folded.leftTrimmed;
        }
      }
      text += `${separator}${part}`;
    }
    const items = [];
    source.forEach((segment, index) => {
      const owned = Array.isArray(segment?.items) ? segment.items : [];
      const ownedText = owned.map(item => String(item?.text || '')).join('');
      // 先从尾部裁掉折叠掉的闭符号，再从头部裁掉开符号；被裁空的 item 一并
      // 移除（纯符号 item 没有可保留的时间语义）。
      const removedEnd = texts[index].slice(texts[index].length - trailingSlices[index]);
      let endCut = removedEnd && ownedText.endsWith(removedEnd) ? removedEnd.length : 0;
      const trimmedEnd = [];
      for (let cursor = owned.length - 1; cursor >= 0; cursor -= 1) {
        const itemText = String(owned[cursor]?.text || '');
        if (endCut > 0) {
          if (!itemText) continue;
          if (itemText.length <= endCut) {
            endCut -= itemText.length;
            continue;
          }
          trimmedEnd.unshift({ ...owned[cursor], text: itemText.slice(0, itemText.length - endCut) });
          endCut = 0;
          continue;
        }
        trimmedEnd.unshift(owned[cursor]);
      }
      const removedStart = texts[index].slice(0, leadingSlices[index]);
      let startCut = removedStart && ownedText.startsWith(removedStart) ? removedStart.length : 0;
      // 折叠边界把 separator 插回文本层后，items 层把它归位到该段首个存活
      // item 的开头（与词级 item 空格前置的约定一致），使 items 拼接与合并
      // 文本继续守恒；未折叠的边界维持原状（分隔符不落 items）。
      let pendingSeparator = index > 0 && separator !== '' && leadingSlices[index] > 0;
      for (const item of trimmedEnd) {
        const itemText = String(item?.text || '');
        if (startCut > 0) {
          if (!itemText) continue;
          if (itemText.length <= startCut) {
            startCut -= itemText.length;
            continue;
          }
          items.push({ ...item, text: `${pendingSeparator ? separator : ''}${itemText.slice(startCut)}` });
          pendingSeparator = false;
          startCut = 0;
          continue;
        }
        if (pendingSeparator) {
          if (!itemText) continue;
          items.push({ ...item, text: `${separator}${itemText}` });
          pendingSeparator = false;
          continue;
        }
        items.push(item);
      }
    });
    return { text, items };
  }


  // 「左右添加字符」预设：主字幕右键菜单与批量面板共用同一张数据表，便于后续加项。
  // 一律使用双符号形式；「单双符号」设置只影响识别/解析，不影响这里插入的内容。
  // 数组序即菜单与批量面板的展示序；sentenceLevel: true 的预设是句级效果
  // （整句生效，插入时恒包裹在所有符号最外层），菜单与面板按它分组。
  const WRAP_CHAR_PRESETS = Object.freeze([
    // ass: true 的预设是 ASS 特殊文本格式，仅在当前工程启用 ASS 字幕模式时展示。
    { id: 'emphasis', label: '强调文本', left: '**', right: '**', ass: true },
    { id: 'large', label: '放大文本', left: '++', right: '++', ass: true },
    { id: 'comment', label: '弱化文本', left: '%%', right: '%%', ass: true },
    { id: 'small', label: '缩小文本', left: '--', right: '--', ass: true },
    { id: 'italic', label: '斜体文本', left: '//', right: '//', ass: true },
    { id: 'strike', label: '删除线', left: '~~', right: '~~', ass: true },
    { id: 'underline', label: '下划线', left: '__', right: '__', ass: true },
    { id: 'fade', label: '淡出淡入', left: '>>', right: '<<', ass: true, sentenceLevel: true },
    { id: 'shake', label: '原地震动', left: '!!', right: '!!', ass: true, sentenceLevel: true },
    { id: 'pop', label: '放大出现', left: '{{', right: '}}', ass: true, sentenceLevel: true },
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
  function wrapCharsAroundText(text, left, right, rule = 'both') {
    const source = String(text == null ? '' : text);
    const l = String(left == null ? '' : left);
    const r = String(right == null ? '' : right);
    if (source === '' || (!l && !r)) return { changed: false, skipped: false, text: source };
    const result = wrapPreservingSentenceShells(source, l, r, true, rule);
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
    parseSentencePopMarkers,
    stripSentencePopMarkers,
    completeSplitMassPairs,
    completeMassTextRows,
    appendMassMarkersToLastItem,
    prependMassMarkersToFirstItem,
    foldMassPairJunction,
    joinSegmentTextsMassFold,
    massMarkedRanges,
    stripMassMarkers,
    convertChineseNumbers,
    WRAP_CHAR_PRESETS,
    isTextWrappedBy,
    wrapCharsAroundText,
  });
}
