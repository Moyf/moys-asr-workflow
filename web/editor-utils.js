// Pure editor helpers kept separate so replacement behavior can be tested
// without constructing the full browser editor DOM.
(function () {
  'use strict';

  const SUBTITLE_FONT_FAMILY_DISPLAY_NAMES_ZH = Object.freeze({
    'Microsoft YaHei': '微软雅黑',
    'Microsoft YaHei UI': '微软雅黑',
    SimHei: '黑体',
    SimSun: '宋体',
    NSimSun: '新宋体',
    FangSong: '仿宋',
    KaiTi: '楷体',
    'PingFang SC': '苹方',
    'Heiti SC': '黑体-简',
    'Songti SC': '宋体-简',
    'Kaiti SC': '楷体-简',
    'Source Han Sans SC': '思源黑体',
    'Source Han Serif SC': '思源宋体',
    'Noto Sans CJK SC': 'Noto Sans CJK 简体中文',
    'Noto Serif CJK SC': 'Noto Serif CJK 简体中文',
  });
  const PROJECT_SCHEMA = 'moy.asr.project.v1';

  function supportsProjectSchema(project) {
    if (!project || typeof project !== 'object' || Array.isArray(project)) return false;
    return project.schema === undefined || project.schema === PROJECT_SCHEMA;
  }

  function subtitleFontFamilyDisplayName(family, language) {
    if (language !== 'zh' || typeof family !== 'string') return family;
    return SUBTITLE_FONT_FAMILY_DISPLAY_NAMES_ZH[family] || family;
  }

  // 字体输入框（datalist 搜索）与存储值之间的双向映射。
  // 预设内置字体以 key 存储；本机字体以真实字体族名存储——datalist 展示的
  // 本地化别名（如「微软雅黑」）提交时必须还原，否则浏览器无法解析该名称。
  const SUBTITLE_FONT_FAMILY_PRESETS = Object.freeze([
    { key: 'default', label: '默认无衬线' },
    { key: 'yahei', label: '微软雅黑 / 苹方' },
    { key: 'hei', label: '黑体' },
    { key: 'song', label: '宋体' },
    { key: 'sans', label: 'Arial / Segoe UI' },
  ]);

  function subtitleFontFamilyStoredToInput(family, {
    presets = SUBTITLE_FONT_FAMILY_PRESETS,
    presetLabel = (preset) => preset.label,
    familyDisplay = (candidate) => candidate,
  } = {}) {
    const key = family || 'default';
    const preset = presets.find((item) => item.key === key);
    if (preset) return presetLabel(preset);
    return familyDisplay(key);
  }

  function subtitleFontFamilyInputToStored(text, {
    presets = SUBTITLE_FONT_FAMILY_PRESETS,
    presetLabel = (preset) => preset.label,
    localFamilies = [],
    familyDisplay = (candidate) => candidate,
  } = {}) {
    const value = String(text || '').trim();
    if (!value) return 'default';
    const preset = presets.find((item) => (
      item.label === value || item.key === value || presetLabel(item) === value
    ));
    if (preset) return preset.key;
    const family = (Array.isArray(localFamilies) ? localFamilies : []).find((candidate) => (
      candidate === value || familyDisplay(candidate) === value
    ));
    return family || value;
  }

  // combobox 下拉选项：按显示名合并预设与本机字体并去重。
  // 预设与扫描结果经常重叠（如 Arial / Microsoft YaHei），去重时保留先出现的项。
  function mergeFontFamilyOptions(entries) {
    const seen = new Set();
    const result = [];
    (Array.isArray(entries) ? entries : []).forEach((entry) => {
      const value = typeof entry?.value === 'string' ? entry.value.trim() : '';
      if (!value) return;
      const label = typeof entry?.label === 'string' && entry.label.trim()
        ? entry.label.trim() : value;
      const key = label.toLocaleLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      result.push({ value, label });
    });
    return result;
  }

  // 过滤字体下拉选项：开头匹配（前缀）排在包含匹配之前，两组各自保持原有相对顺序。
  function filterFontFamilyOptions(entries, query) {
    const normalized = String(query || '').trim().toLocaleLowerCase();
    const source = Array.isArray(entries) ? entries : [];
    if (!normalized) return source;
    const startsWith = [];
    const contains = [];
    source.forEach((entry) => {
      const label = String(entry?.label || '').toLocaleLowerCase();
      if (label.startsWith(normalized)) startsWith.push(entry);
      else if (label.includes(normalized)) contains.push(entry);
    });
    return startsWith.concat(contains);
  }

  const SPEAKER_LABEL_COLORS = Object.freeze([
    'yellow', 'green', 'red', 'purple', 'blue',
  ]);
  const DEFAULT_SPEAKER_LABELS = Object.freeze({
    yellow: 'SP1',
    green: 'SP2',
    red: 'SP3',
    purple: 'SP4',
    blue: 'SP5',
  });
  const SPEAKER_LABEL_MAX_LENGTH = 64;
  const DEFAULT_SPEAKER_LABEL_SEPARATOR = '：';
  const SPEAKER_LABEL_SEPARATOR_MAX_LENGTH = 16;

  function normalizeSpeakerLabel(value, fallback = '') {
    if (typeof value !== 'string') return fallback;
    const normalized = value
      .replace(/[\u0000-\u001f\u007f]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim();
    return normalized.length <= SPEAKER_LABEL_MAX_LENGTH ? normalized : fallback;
  }

  function normalizeSpeakerLabels(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return Object.fromEntries(SPEAKER_LABEL_COLORS.map((color) => [
      color,
      Object.prototype.hasOwnProperty.call(source, color)
        ? normalizeSpeakerLabel(source[color], DEFAULT_SPEAKER_LABELS[color])
        : DEFAULT_SPEAKER_LABELS[color],
    ]));
  }

  function normalizeSpeakerLabelSeparator(value) {
    if (typeof value !== 'string') return DEFAULT_SPEAKER_LABEL_SEPARATOR;
    const normalized = value.replace(/[\u0000-\u001f\u007f]/g, '');
    return normalized.length <= SPEAKER_LABEL_SEPARATOR_MAX_LENGTH
      ? normalized
      : DEFAULT_SPEAKER_LABEL_SEPARATOR;
  }

  function normalizeSpeakerLabelSettings(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const hasMappingEnabled = Object.prototype.hasOwnProperty.call(source, 'mapping_enabled');
    const hasEnabled = Object.prototype.hasOwnProperty.call(source, 'enabled');
    return {
      // 旧工程没有独立的映射开关时，沿用原来的 enabled 语义，避免升级后
      // 已配置的说话人名称突然失效；新工程的预览名称默认开启，显式 false 仍保留。
      mapping_enabled: hasMappingEnabled ? source.mapping_enabled === true : source.enabled === true,
      enabled: hasEnabled ? source.enabled === true : true,
      separator: normalizeSpeakerLabelSeparator(source.separator),
      names: normalizeSpeakerLabels(source.names),
    };
  }

  function speakerLabelForSegment(segment, segments, labels) {
    const colorName = effectiveColorName(segment, segments);
    if (!colorName) return '';
    return normalizeSpeakerLabels(labels)[colorName] || '';
  }

  function formatSpeakerLabelledText(
    text,
    segment,
    segments,
    labels,
    separator = DEFAULT_SPEAKER_LABEL_SEPARATOR,
  ) {
    const content = String(text ?? '');
    const label = speakerLabelForSegment(segment, segments, labels);
    return label ? `${label}${normalizeSpeakerLabelSeparator(separator)}${content}` : content;
  }

  // SRT files commonly come from Windows subtitle tools, which may save them
  // as UTF-8 (with or without BOM) or as the local GBK code page. Decode the
  // bytes here instead of relying on File.text(), whose encoding is fixed to
  // UTF-8 and turns GBK Chinese into replacement characters.
  function decodeSubtitleText(input) {
    if (typeof input === 'string') return input.replace(/^\uFEFF/, '');
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || []);
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
      return new TextDecoder('utf-8').decode(bytes.subarray(3));
    }
    if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
      return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    }
    if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
      return new TextDecoder('utf-16be').decode(bytes.subarray(2));
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return new TextDecoder('gb18030').decode(bytes);
    }
  }

  function readUint32LittleEndian(bytes, offset) {
    if (offset < 0 || offset + 4 > bytes.length) return null;
    return (
      bytes[offset]
      | (bytes[offset + 1] << 8)
      | (bytes[offset + 2] << 16)
      | (bytes[offset + 3] << 24)
    ) >>> 0;
  }

  function parseBwfTimeReference(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || []);
    if (bytes.length < 12) return null;
    const isRiff = bytes[0] === 0x52 && bytes[1] === 0x49
      && bytes[2] === 0x46 && bytes[3] === 0x46;
    const isRf64 = bytes[0] === 0x52 && bytes[1] === 0x46
      && bytes[2] === 0x36 && bytes[3] === 0x34;
    const isWave = bytes[8] === 0x57 && bytes[9] === 0x41
      && bytes[10] === 0x56 && bytes[11] === 0x45;
    if ((!isRiff && !isRf64) || !isWave) return null;

    let offset = 12;
    let sampleRate = null;
    let timeReferenceSamples = null;
    while (offset + 8 <= bytes.length) {
      const chunkId = String.fromCharCode(
        bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3],
      );
      const chunkSize = readUint32LittleEndian(bytes, offset + 4);
      if (chunkSize === null) break;
      const payloadStart = offset + 8;
      if (chunkSize > bytes.length - payloadStart) break;

      if (chunkId === 'fmt ' && chunkSize >= 8) {
        sampleRate = readUint32LittleEndian(bytes, payloadStart + 4);
      } else if (chunkId === 'bext' && chunkSize >= 346) {
        const low = readUint32LittleEndian(bytes, payloadStart + 338);
        const high = readUint32LittleEndian(bytes, payloadStart + 342);
        if (low !== null && high !== null) {
          timeReferenceSamples = high * 0x100000000 + low;
        }
      }
      if (
        Number.isInteger(sampleRate)
        && sampleRate > 0
        && Number.isSafeInteger(timeReferenceSamples)
        && timeReferenceSamples >= 0
      ) {
        return {
          sample_rate: sampleRate,
          time_reference_samples: timeReferenceSamples,
        };
      }
      offset = payloadStart + chunkSize + (chunkSize % 2);
    }
    return null;
  }

  async function readBwfTimeReferenceFromFile(file) {
    if (!file || !/\.wav$/iu.test(String(file.name || '')) || typeof file.slice !== 'function') {
      return null;
    }
    const header = await file.slice(0, 1024 * 1024).arrayBuffer();
    return parseBwfTimeReference(new Uint8Array(header));
  }

  const KEYBOARD_OPERATION_REFERENCE_MODES = new Set(['pointer', 'playhead']);

  function normalizeKeyboardOperationReferenceMode(value) {
    return KEYBOARD_OPERATION_REFERENCE_MODES.has(value) ? value : 'pointer';
  }

  function resolveKeyboardOperationReference(mode, { pointer = null, playheadTarget = null } = {}) {
    const resolvedMode = normalizeKeyboardOperationReferenceMode(mode);
    if (resolvedMode === 'pointer') {
      if (!pointer || !Number.isFinite(Number(pointer.timeMs))) return null;
      const track = pointer.track === 'extension' ? 'extension' : 'main';
      return {
        timeMs: Math.round(Number(pointer.timeMs)),
        track,
        trackId: track === 'extension' && typeof pointer.trackId === 'string'
          ? pointer.trackId : null,
        source: 'pointer',
      };
    }
    const timeMs = Number(playheadTarget?.timeMs);
    if (!Number.isFinite(timeMs)) return null;
    const track = playheadTarget?.kind === 'extension' ? 'extension' : 'main';
    return {
      timeMs: Math.round(timeMs),
      track,
      trackId: track === 'extension' && typeof playheadTarget.trackId === 'string'
        ? playheadTarget.trackId : null,
      source: 'playhead',
    };
  }

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

  function timedTextStructureRequested(segments, draftTexts) {
    const source = Array.isArray(segments) ? segments : [];
    const texts = Array.isArray(draftTexts) ? draftTexts : [];
    if (!source.length || source.some((segment) => String(segment?.text || '').includes('\n'))) return false;
    return source.length !== texts.length
      || texts.some((text) => String(text == null ? '' : text).includes('\n'));
  }

  function timedTextDraftLines(draftTexts) {
    return timedTextDraftLineEntries(draftTexts).map((entry) => entry.text);
  }

  function timedTextDraftLineEntries(draftTexts) {
    return (Array.isArray(draftTexts) ? draftTexts : [])
      .flatMap((text, draftIndex) => String(text == null ? '' : text)
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) => ({ text: line, draftIndex })));
  }

  function timedTextRangeIsWhitespace(tokens, range) {
    return tokens.slice(range.start, range.end).every((token) => /\s/u.test(token));
  }

  function retimeTimedTextSlice(items, newText) {
    const source = Array.isArray(items) ? items : [];
    const targetTokens = timedTextTokens(newText);
    const lengths = source.map((item) => timedTextTokens(item?.text).length);
    if (!source.length || lengths.some((length) => length <= 0)) return null;
    const sourceText = source.map((item) => String(item?.text || '')).join('');
    const layout = timedTextItemLayout(sourceText, source);
    const neutralItems = timedTextNeutralInsertionItems(sourceText, layout, newText, true);
    if (neutralItems) return neutralItems;
    if (lengths.reduce((sum, length) => sum + length, 0) !== targetTokens.length) return null;
    let offset = 0;
    return source.map((item, index) => {
      const copy = cloneJsonValue(item);
      const length = lengths[index];
      copy.text = targetTokens.slice(offset, offset + length).join('');
      offset += length;
      return copy;
    });
  }

  const TIMED_TEXT_ESTIMATED_MIN_MS = 100;
  const TIMED_TEXT_ESTIMATED_MS_PER_CHARACTER = 100;

  function timedTextEstimatedDuration(text) {
    const units = Math.max(1, Math.ceil(countTextUnits(text)));
    return Math.max(
      TIMED_TEXT_ESTIMATED_MIN_MS,
      units * TIMED_TEXT_ESTIMATED_MS_PER_CHARACTER,
    );
  }

  function timedTextSegmentBoundary(segment, offset, total) {
    const start = Number(segment?.start);
    const end = Number(segment?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || total <= 0) return null;
    const safeOffset = Math.max(0, Math.min(total, Number(offset) || 0));
    return Math.round(start + ((end - start) * safeOffset) / total);
  }

  function emptyTimedTextStructurePlan(error = '') {
    return {
      valid: false,
      type: null,
      error,
      mode: null,
      segments: [],
      outputMeta: [],
      sourceOutputIndexes: [],
      affectedSourceIndexes: [],
      removedSourceIndexes: [],
    };
  }

  function findTimedTextTokenSequence(sourceTokens, targetTokens, fromIndex) {
    if (!targetTokens.length) return -1;
    for (let index = Math.max(0, fromIndex); index + targetTokens.length <= sourceTokens.length; index += 1) {
      if (sameTimedTextTokens(
        sourceTokens.slice(index, index + targetTokens.length),
        targetTokens,
      )) return index;
    }
    return -1;
  }

  function findTimedTextTokenSequences(sourceTokens, targetTokens) {
    if (!targetTokens.length) return [];
    const matches = [];
    for (let index = 0; index + targetTokens.length <= sourceTokens.length; index += 1) {
      if (sameTimedTextTokens(
        sourceTokens.slice(index, index + targetTokens.length),
        targetTokens,
      )) matches.push({ start: index, end: index + targetTokens.length });
    }
    return matches;
  }

  function findTimedTextNeutralAwareSequences(sourceTokens, targetTokens) {
    const sourcePositions = [];
    const sourceAnchors = [];
    sourceTokens.forEach((token, index) => {
      if (isTimedTextNeutralToken(token, true)) return;
      sourcePositions.push(index);
      sourceAnchors.push(token);
    });
    const targetAnchors = targetTokens.filter((token) => !isTimedTextNeutralToken(token, true));
    if (!targetAnchors.length) return [];
    const matches = [];
    for (let index = 0; index + targetAnchors.length <= sourceAnchors.length; index += 1) {
      if (!sameTimedTextTokens(
        sourceAnchors.slice(index, index + targetAnchors.length),
        targetAnchors,
      )) continue;
      let rangeStart = sourcePositions[index];
      let rangeEnd = sourcePositions[index + targetAnchors.length - 1] + 1;
      while (rangeStart > 0 && isTimedTextNeutralToken(sourceTokens[rangeStart - 1], true)) {
        rangeStart -= 1;
      }
      while (rangeEnd < sourceTokens.length && isTimedTextNeutralToken(sourceTokens[rangeEnd], true)) {
        rangeEnd += 1;
      }
      matches.push({ start: rangeStart, end: rangeEnd });
    }
    return matches;
  }

  function timedTextAnchorCandidates(sourceTokens, lineTokens, sourceOffsets) {
    const boundaries = new Set([0]);
    sourceOffsets.forEach((range) => {
      boundaries.add(range.start);
      boundaries.add(range.end);
    });
    const candidates = [];
    lineTokens.forEach((tokens, lineIndex) => {
      const seen = new Set();
      const append = (range, neutralAware = false) => {
        if (!range || range.start >= range.end || seen.has(`${range.start}:${range.end}`)) return;
        const startsAtBoundary = boundaries.has(range.start);
        const endsAtBoundary = boundaries.has(range.end);
        // 内部片段太容易把真正的后续字幕误认成锚点；拆分/合并只接受
        // 至少一侧落在原字幕边界上的匹配。完全内部的片段留给区间估算。
        if (!startsAtBoundary && !endsAtBoundary) return;
        const wholeSource = !neutralAware && sourceOffsets.some((sourceRange) => (
          sourceRange.start === range.start && sourceRange.end === range.end
        ));
        const boundaryScore = wholeSource
          ? 100000000
          : (startsAtBoundary && endsAtBoundary ? 1000000 : 10000);
        seen.add(`${range.start}:${range.end}`);
        candidates.push({
          lineIndex,
          start: range.start,
          end: range.end,
          score: boundaryScore + Math.min(tokens.length, 10000),
        });
      };
      findTimedTextTokenSequences(sourceTokens, tokens).forEach((range) => append(range));
      findTimedTextNeutralAwareSequences(sourceTokens, tokens)
        .forEach((range) => append(range, true));
    });
    return candidates;
  }

  function selectTimedTextAnchors(sourceTokens, lineTokens, sourceOffsets) {
    const candidates = timedTextAnchorCandidates(sourceTokens, lineTokens, sourceOffsets);
    if (!candidates.length) return [];
    const states = candidates.map((candidate) => ({
      score: candidate.score,
      count: 1,
      coveredLength: candidate.end - candidate.start,
      previous: -1,
    }));
    const isBetter = (left, right) => {
      if (!right) return true;
      if (left.score !== right.score) return left.score > right.score;
      if (left.count !== right.count) return left.count > right.count;
      if (left.coveredLength !== right.coveredLength) return left.coveredLength > right.coveredLength;
      return left.previous < right.previous;
    };
    for (let current = 0; current < candidates.length; current += 1) {
      const candidate = candidates[current];
      for (let previous = 0; previous < current; previous += 1) {
        const previousCandidate = candidates[previous];
        if (previousCandidate.lineIndex >= candidate.lineIndex
            || previousCandidate.end > candidate.start) continue;
        const proposal = {
          score: states[previous].score + candidate.score,
          count: states[previous].count + 1,
          coveredLength: states[previous].coveredLength + candidate.end - candidate.start,
          previous,
        };
        if (isBetter(proposal, states[current])) states[current] = proposal;
      }
    }
    let last = -1;
    for (let index = 0; index < states.length; index += 1) {
      if (last < 0 || isBetter(states[index], states[last])) last = index;
    }
    const selected = [];
    while (last >= 0) {
      selected.push(candidates[last]);
      last = states[last].previous;
    }
    return selected.reverse();
  }

  function buildTimedTextStructurePlan(segments, draftTexts) {
    const source = Array.isArray(segments) ? segments : [];
    const texts = Array.isArray(draftTexts) ? draftTexts : [];
    if (!timedTextStructureRequested(source, texts)) return emptyTimedTextStructurePlan();
    // 空行表示用户清空了对应字幕；纯文本视图不再保留空字幕行，直接将其视为删除标记。
    const lineEntries = timedTextDraftLineEntries(texts)
      .filter((entry) => String(entry.text).trim() !== '');
    const lines = lineEntries.map((entry) => entry.text);

    const sourceTokens = source.map((segment) => timedTextTokens(segment?.text));
    const sourceOffsets = [];
    let totalCharacters = 0;
    sourceTokens.forEach((tokens) => {
      sourceOffsets.push({ start: totalCharacters, end: totalCharacters + tokens.length });
      totalCharacters += tokens.length;
    });
    if (!totalCharacters) return emptyTimedTextStructurePlan('当前字幕没有可用于拆分的文字。');
    const flattenedSource = sourceTokens.flat();
    const lineTokens = lines.map((line) => timedTextTokens(line));
    const lineRanges = [];
    let exactCursor = 0;
    let exact = true;
    for (const tokens of lineTokens) {
      const start = findTimedTextTokenSequence(flattenedSource, tokens, exactCursor);
      if (start < 0) {
        exact = false;
        break;
      }
      lineRanges.push({ start, end: start + tokens.length });
      exactCursor = start + tokens.length;
    }

    let mode = 'exact';
    if (exact) {
      const gaps = [];
      let previous = 0;
      lineRanges.forEach((range) => {
        if (range.start > previous) gaps.push({ start: previous, end: range.start });
        previous = range.end;
      });
      if (previous < totalCharacters) gaps.push({ start: previous, end: totalCharacters });
      const boundaries = new Set([0, ...sourceOffsets.flatMap((range) => [range.start, range.end])]);
      if (gaps.some((gap) => (
        (!boundaries.has(gap.start) || !boundaries.has(gap.end))
        && !timedTextRangeIsWhitespace(flattenedSource, gap)
      ))) {
        return emptyTimedTextStructurePlan('删除字幕时只能删除完整字幕行，不能只删除其中一部分文字。');
      }
    } else {
      // 某些前面的句子被改写后，仍尝试从后面的未改文字建立锚点。
      // 锚点之间的新增/改写区域只允许走字幕段级估算，不能再按原始 index 猜。
      const anchors = Array.from({ length: lineTokens.length }, () => null);
      // 不再按草稿顺序贪心地拿每一个“看起来能匹配”的片段。一个较短的
      // 内部片段可能会抢先消耗真正属于后面字幕的文字，之后所有行只能按
      // 比例估算，最终表现为“一句错、句句错”。先收集全局候选，再选择一组
      // 顺序一致且尽量覆盖完整原字幕的锚点，让未改字幕优先成为稳定边界。
      const selectedAnchors = selectTimedTextAnchors(flattenedSource, lineTokens, sourceOffsets);
      selectedAnchors.forEach((anchor) => {
        anchors[anchor.lineIndex] = { start: anchor.start, end: anchor.end };
      });
      const anchorCount = selectedAnchors.length;
      if (!anchorCount) {
        return emptyTimedTextStructurePlan('无法根据原文重新匹配拆句结果；请保留至少一段未改文字作为匹配锚点。');
      }
      mode = 'anchor';
      let previousLineIndex = -1;
      let previousSourceEnd = 0;
      const anchorIndexes = anchors
        .map((anchor, index) => (anchor ? index : -1))
        .filter((index) => index >= 0);
      for (const nextLineIndex of [...anchorIndexes, lineTokens.length]) {
        const nextAnchor = nextLineIndex < lineTokens.length ? anchors[nextLineIndex] : null;
        const sourceEnd = nextAnchor?.start ?? totalCharacters;
        const missingIndexes = [];
        for (let index = previousLineIndex + 1; index < nextLineIndex; index += 1) {
          if (!anchors[index]) missingIndexes.push(index);
        }
        const targetLength = missingIndexes.reduce((sum, index) => sum + lineTokens[index].length, 0);
        const sourceLength = sourceEnd - previousSourceEnd;
        if (missingIndexes.length && (targetLength <= 0 || sourceLength <= 0)) {
          return emptyTimedTextStructurePlan('无法根据原文重新匹配拆句结果；改写区域缺少可用时间范围。');
        }
        let targetOffset = 0;
        missingIndexes.forEach((index) => {
          const start = previousSourceEnd + Math.round((sourceLength * targetOffset) / targetLength);
          targetOffset += lineTokens[index].length;
          const end = previousSourceEnd + Math.round((sourceLength * targetOffset) / targetLength);
          if (end <= start) {
            lineRanges.length = 0;
            return;
          }
          lineRanges[index] = { start, end };
        });
        if (nextAnchor) {
          lineRanges[nextLineIndex] = nextAnchor;
          previousLineIndex = nextLineIndex;
          previousSourceEnd = nextAnchor.end;
        } else {
          previousLineIndex = lineTokens.length - 1;
          previousSourceEnd = totalCharacters;
        }
      }
      if (lineRanges.length !== lineTokens.length || lineRanges.some((range) => !range)) {
        return emptyTimedTextStructurePlan('无法根据原文重新匹配拆句结果；请减少连续改写的字幕行。');
      }
    }

    const layouts = source.map((segment) => timedTextItemLayout(segment?.text, segment?.items));
    const outputSegments = [];
    const outputMeta = [];
    const sourceOutputIndexes = Array.from({ length: source.length }, () => []);
    let previousOutputEnd = null;
    for (const [outputIndex, range] of lineRanges.entries()) {
      const overlaps = sourceOffsets
        .map((sourceRange, sourceIndex) => ({ sourceRange, sourceIndex }))
        .filter(({ sourceRange }) => range.start < sourceRange.end && range.end > sourceRange.start);
      if (!overlaps.length) return emptyTimedTextStructurePlan('无法找到新字幕对应的原始时间范围。');

      const first = overlaps[0].sourceIndex;
      const last = overlaps[overlaps.length - 1].sourceIndex;
      const firstLocal = range.start - sourceOffsets[first].start;
      const lastLocal = range.end - sourceOffsets[last].start;
      const isWholeUnchangedSource = overlaps.length === 1
        && firstLocal === 0
        && lastLocal === sourceTokens[first].length
        && lines[outputIndex] === String(source[first]?.text || '');
      let items = null;
      let timingEstimated = false;
      if (isWholeUnchangedSource) {
        // 末尾多出的空行等不会改变字幕结构；没有字词时间码时也可以安全地保留这个无变化行。
        items = Array.isArray(source[first]?.items) ? cloneJsonValue(source[first].items) : null;
      } else {
        const originalItems = [];
        let canReuseItems = true;
        for (const { sourceRange, sourceIndex } of overlaps) {
          const localStart = Math.max(0, range.start - sourceRange.start);
          const localEnd = Math.min(sourceRange.end - sourceRange.start, range.end - sourceRange.start);
          if (localStart >= localEnd) continue;
          if (!layouts[sourceIndex]) {
            canReuseItems = false;
            break;
          }
          const slice = timedTextItemsSlice(layouts[sourceIndex], localStart, localEnd);
          if (!slice?.length) {
            canReuseItems = false;
            break;
          }
          originalItems.push(...slice);
        }
        items = canReuseItems ? retimeTimedTextSlice(originalItems, lines[outputIndex]) : null;
        if (!items?.length || !timedTextItemsOrdered(items)) {
          // 没有完整字词时间码时仍允许拆句，但只生成字幕段级时间范围，
          // 并在报告中明确标记为按范围/字数估算，绝不伪造精确 items。
          items = null;
          timingEstimated = true;
        }
      }
      let start = items?.length
        ? (firstLocal === 0 ? Number(source[first]?.start) : Number(items[0].start))
        : timedTextSegmentBoundary(source[first], firstLocal, sourceTokens[first].length);
      let end = items?.length
        ? (lastLocal === sourceTokens[last].length
          ? Number(source[last]?.end) : Number(items[items.length - 1].end))
        : timedTextSegmentBoundary(source[last], lastLocal, sourceTokens[last].length);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        timingEstimated = true;
        start = Number.isFinite(previousOutputEnd) ? previousOutputEnd : 0;
        end = start + timedTextEstimatedDuration(lines[outputIndex]);
      } else if (timingEstimated) {
        if (Number.isFinite(previousOutputEnd) && start < previousOutputEnd) start = previousOutputEnd;
        end = Math.max(end, start + TIMED_TEXT_ESTIMATED_MIN_MS);
      }
      const nextSourceStart = Number(source[last + 1]?.start);
      if (timingEstimated && Number.isFinite(nextSourceStart)) {
        if (start >= nextSourceStart) {
          return emptyTimedTextStructurePlan('自动估算的字幕时间范围没有足够空间，不能越过下一条字幕的开头。');
        }
        end = Math.min(end, nextSourceStart);
        if (end - start < TIMED_TEXT_ESTIMATED_MIN_MS) {
          return emptyTimedTextStructurePlan('自动估算的字幕时间范围不足 100ms，且不能越过下一条字幕的开头。');
        }
      }
      if (end <= start) {
        return emptyTimedTextStructurePlan('拆句后产生了无效的字幕时间范围。');
      }
      const segment = cloneJsonValue(source[first] || {});
      segment.start = start;
      segment.end = end;
      segment.text = lines[outputIndex];
      if (!isWholeUnchangedSource) {
        if (items?.length) segment.items = items;
        else delete segment.items;
      }
      outputSegments.push(segment);
      outputMeta.push({
        sourceIndexes: overlaps.map(({ sourceIndex }) => sourceIndex),
        range,
        timingEstimated,
        draftIndex: lineEntries[outputIndex]?.draftIndex,
      });
      overlaps.forEach(({ sourceIndex }) => sourceOutputIndexes[sourceIndex].push(outputIndex));
      previousOutputEnd = end;
    }

    const usedSegments = [...source];
    outputMeta.forEach((meta, outputIndex) => {
      const sourceIndex = meta.sourceIndexes[0];
      const sourceSegment = source[sourceIndex] || {};
      const sourceRange = sourceOffsets[sourceIndex];
      const firstOutputForSource = sourceOutputIndexes[sourceIndex][0] === outputIndex;
      const canKeepSourceId = firstOutputForSource && meta.range.start === sourceRange.start;
      if (canKeepSourceId && sourceSegment.id) {
        outputSegments[outputIndex].id = sourceSegment.id;
      } else {
        const baseId = `${sourceSegment.id || `segment-${sourceIndex + 1}`}-text-${outputIndex + 1}`;
        outputSegments[outputIndex].id = uniqueStableSegmentId(usedSegments, baseId, 'segment');
      }
      usedSegments.push(outputSegments[outputIndex]);
      if (sourceSegment.sticker && !firstOutputForSource) {
        outputSegments[outputIndex].sticker = null;
        outputSegments[outputIndex].sticker_ref = {
          name: sourceSegment.sticker.name,
          headIdx: sourceOutputIndexes[sourceIndex][0],
        };
      }
      if (sourceSegment.color && !firstOutputForSource) {
        outputSegments[outputIndex].color = null;
        outputSegments[outputIndex].color_ref = {
          name: sourceSegment.color.name,
          headIdx: sourceOutputIndexes[sourceIndex][0],
        };
      }
    });

    const affectedSourceIndexes = [];
    sourceOutputIndexes.forEach((outputIndexes, sourceIndex) => {
      if (outputIndexes.length !== 1) {
        affectedSourceIndexes.push(sourceIndex);
        return;
      }
      const meta = outputMeta[outputIndexes[0]];
      const range = sourceOffsets[sourceIndex];
      const output = outputSegments[outputIndexes[0]];
      if (meta.sourceIndexes.length !== 1
          || meta.range.start !== range.start
          || meta.range.end !== range.end
          || output.text !== source[sourceIndex]?.text) affectedSourceIndexes.push(sourceIndex);
    });

    const removedSourceIndexes = sourceOutputIndexes
      .map((outputIndexes, sourceIndex) => outputIndexes.length ? -1 : sourceIndex)
      .filter((index) => index >= 0);
    const hasSplit = sourceOutputIndexes.some((indexes) => indexes.length > 1);
    const hasMerge = outputMeta.some((meta) => meta.sourceIndexes.length > 1);
    const hasDelete = removedSourceIndexes.length > 0;
    const type = [hasSplit ? 'split' : '', hasMerge ? 'merge' : '', hasDelete ? 'delete' : '']
      .filter(Boolean).join('+');
    return {
      valid: true,
      type: type || 'resegment',
      error: '',
      mode,
      segments: outputSegments,
      outputMeta,
      sourceOutputIndexes,
      affectedSourceIndexes,
      removedSourceIndexes,
    };
  }

  function sameTimedTextTokens(left, right) {
    return left.length === right.length && left.every((token, index) => token === right[index]);
  }

  function hasTimedTextContent(tokens) {
    return tokens.some((token) => token.trim() !== '');
  }

  function detectTimedTextBoundaryMoves(segments, draftTexts) {
    const source = Array.isArray(segments) ? segments : [];
    const texts = Array.isArray(draftTexts) ? draftTexts : [];
    if (source.length !== texts.length) return [];
    const candidates = [];

    // 当前字幕的开头移到上一条末尾：上一条新增的尾巴必须完整来自当前字幕开头。
    for (let index = 1; index < source.length; index += 1) {
      const previousBefore = timedTextTokens(source[index - 1]?.text);
      const previousAfter = timedTextTokens(texts[index - 1]);
      const currentBefore = timedTextTokens(source[index]?.text);
      if (previousAfter.length <= previousBefore.length) continue;
      const moved = previousAfter.slice(previousBefore.length);
      if (!hasTimedTextContent(moved)
          || !sameTimedTextTokens(previousAfter.slice(0, previousBefore.length), previousBefore)
          || !sameTimedTextTokens(currentBefore.slice(0, moved.length), moved)) continue;
      candidates.push({
        type: 'prefix-to-previous',
        sourceIndex: index,
        targetIndex: index - 1,
        movedTokens: moved,
      });
    }

    // 当前字幕的结尾移到下一条开头：下一条新增的开头必须完整来自当前字幕结尾。
    for (let index = 0; index < source.length - 1; index += 1) {
      const currentBefore = timedTextTokens(source[index]?.text);
      const nextBefore = timedTextTokens(source[index + 1]?.text);
      const nextAfter = timedTextTokens(texts[index + 1]);
      if (nextAfter.length <= nextBefore.length) continue;
      const moved = nextAfter.slice(0, nextAfter.length - nextBefore.length);
      if (!hasTimedTextContent(moved)
          || !sameTimedTextTokens(nextAfter.slice(moved.length), nextBefore)
          || !sameTimedTextTokens(currentBefore.slice(currentBefore.length - moved.length), moved)) continue;
      candidates.push({
        type: 'suffix-to-next',
        sourceIndex: index,
        targetIndex: index + 1,
        movedTokens: moved,
      });
    }
    return candidates;
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

  function emptyTimedTextBoundaryPlan(source) {
    return {
      transfers: [],
      updates: Array.from({ length: source.length }, () => null),
    };
  }

  function buildTimedTextBoundaryPlan(segments, draftTexts) {
    const source = Array.isArray(segments) ? segments : [];
    const texts = Array.isArray(draftTexts) ? draftTexts : [];
    if (source.length !== texts.length) return emptyTimedTextBoundaryPlan(source);
    const candidates = detectTimedTextBoundaryMoves(source, texts);
    if (!candidates.length) return emptyTimedTextBoundaryPlan(source);

    const prefixCounts = Array.from({ length: source.length }, () => 0);
    const suffixCounts = Array.from({ length: source.length }, () => 0);
    const incomingPrefixes = Array.from({ length: source.length }, () => null);
    const incomingSuffixes = Array.from({ length: source.length }, () => null);
    for (const candidate of candidates) {
      const movedLength = candidate.movedTokens.length;
      if (candidate.type === 'prefix-to-previous') {
        if (prefixCounts[candidate.sourceIndex] || incomingSuffixes[candidate.targetIndex]) {
          return emptyTimedTextBoundaryPlan(source);
        }
        prefixCounts[candidate.sourceIndex] = movedLength;
        incomingSuffixes[candidate.targetIndex] = candidate;
      } else {
        if (suffixCounts[candidate.sourceIndex] || incomingPrefixes[candidate.targetIndex]) {
          return emptyTimedTextBoundaryPlan(source);
        }
        suffixCounts[candidate.sourceIndex] = movedLength;
        incomingPrefixes[candidate.targetIndex] = candidate;
      }
    }

    const partitions = Array.from({ length: source.length }, () => null);
    const affectedIndexes = new Set();
    candidates.forEach((candidate) => {
      affectedIndexes.add(candidate.sourceIndex);
      affectedIndexes.add(candidate.targetIndex);
    });

    for (const index of affectedIndexes) {
      const beforeTokens = timedTextTokens(source[index]?.text);
      const prefixCount = prefixCounts[index];
      const suffixCount = suffixCounts[index];
      if (prefixCount + suffixCount > beforeTokens.length) {
        return emptyTimedTextBoundaryPlan(source);
      }
      const layout = timedTextItemLayout(source[index]?.text, source[index]?.items);
      if (!layout) return emptyTimedTextBoundaryPlan(source);
      const partition = timedTextItemsPartition(layout, prefixCount, suffixCount);
      if (!partition) {
        return emptyTimedTextBoundaryPlan(source);
      }
      partitions[index] = { layout, ...partition };
    }

    for (const candidate of candidates) {
      const partition = partitions[candidate.sourceIndex];
      candidate.movedItems = candidate.type === 'prefix-to-previous'
        ? cloneJsonValue(partition.prefix)
        : cloneJsonValue(partition.suffix);
      if (!candidate.movedItems.length
          || candidate.movedItems.map((item) => item.text).join('') !== candidate.movedTokens.join('')) {
        return emptyTimedTextBoundaryPlan(source);
      }
    }

    for (const index of affectedIndexes) {
      const beforeTokens = timedTextTokens(source[index]?.text);
      const prefixTokens = incomingPrefixes[index]?.movedTokens || [];
      const suffixTokens = incomingSuffixes[index]?.movedTokens || [];
      const bodyTokens = beforeTokens.slice(prefixCounts[index], beforeTokens.length - suffixCounts[index]);
      const expectedTokens = [...prefixTokens, ...bodyTokens, ...suffixTokens];
      if (!sameTimedTextTokens(expectedTokens, timedTextTokens(texts[index]))) {
        return emptyTimedTextBoundaryPlan(source);
      }

      const partition = partitions[index];
      const incomingPrefixItems = incomingPrefixes[index]?.movedItems || [];
      const incomingSuffixItems = incomingSuffixes[index]?.movedItems || [];
      const nextItems = [
        ...cloneJsonValue(incomingPrefixItems),
        ...cloneJsonValue(partition.body),
        ...cloneJsonValue(incomingSuffixItems),
      ];
      if ((expectedTokens.length && !nextItems.length)
          || nextItems.map((item) => item.text).join('') !== expectedTokens.join('')
          || !timedTextItemsOrdered(nextItems)) {
        return emptyTimedTextBoundaryPlan(source);
      }

      const segment = source[index];
      let start = Number(segment?.start);
      let end = Number(segment?.end);
      if (nextItems.length) {
        if (prefixCounts[index] || prefixTokens.length) start = Number(nextItems[0].start);
        if (suffixCounts[index] || suffixTokens.length) end = Number(nextItems[nextItems.length - 1].end);
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        return emptyTimedTextBoundaryPlan(source);
      }
      partitions[index].update = {
        text: texts[index],
        items: nextItems,
        start,
        end,
      };
    }

    const updates = Array.from({ length: source.length }, () => null);
    affectedIndexes.forEach((index) => { updates[index] = partitions[index].update; });
    return {
      transfers: candidates.map((candidate) => ({
        type: candidate.type,
        sourceIndex: candidate.sourceIndex,
        targetIndex: candidate.targetIndex,
        movedText: candidate.movedTokens.join(''),
        movedItemCount: candidate.movedItems.length,
      })),
      updates,
    };
  }

  function reconcileTimedTextItems(originalText, rawItems, newText) {
    if (!Array.isArray(rawItems) || !rawItems.length) {
      return { status: 'unavailable', items: null, preservedItems: 0, affectedItems: 0 };
    }
    const layout = timedTextItemLayout(originalText, rawItems);
    if (!layout) {
      const items = Array.isArray(rawItems) ? cloneJsonValue(rawItems) : [];
      return { status: 'lost', items: null, preservedItems: 0, affectedItems: items.length };
    }
    const { items, spans } = layout;
    if (originalText === newText) {
      return { status: 'full', items, preservedItems: items.length, affectedItems: 0 };
    }

    const originalTokens = timedTextTokens(originalText);
    const newTokens = timedTextTokens(newText);
    const neutralItems = timedTextNeutralInsertionItems(originalText, layout, newText);
    if (neutralItems) {
      return {
        status: 'partial',
        items: neutralItems,
        preservedItems: items.length,
        affectedItems: 0,
      };
    }
    // 等长改字是最可靠的错别字修正场景：按原 item 的字符长度重新分配文字，
    // 直接保留每个 item 的时间范围。
    if (originalTokens.length === newTokens.length) {
      let offset = 0;
      items.forEach((item, index) => {
        const length = spans[index].end - spans[index].start;
        item.text = newTokens.slice(offset, offset + length).join('');
        offset += length;
      });
      return { status: 'full', items, preservedItems: items.length, affectedItems: 0 };
    }

    const opcodes = timedTextDiffOpcodes(originalTokens, newTokens);
    if (!opcodes) {
      return { status: 'lost', items: null, preservedItems: 0, affectedItems: items.length };
    }
    const unchanged = opcodes.reduce((total, opcode) => (
      opcode.tag === 'equal' ? total + opcode.sourceEnd - opcode.sourceStart : total
    ), 0);
    const comparableLength = Math.max(1, Math.min(originalTokens.length, newTokens.length));
    const changedOriginal = originalTokens.length - unchanged;
    const changedTarget = newTokens.length - unchanged;
    const sourceFullyAnchored = unchanged === originalTokens.length;
    if (
      unchanged === 0
      || (!sourceFullyAnchored && unchanged < Math.max(1, Math.round(comparableLength * 0.25)))
      || (!sourceFullyAnchored && changedOriginal > originalTokens.length * 0.75)
      || (!sourceFullyAnchored && changedTarget > newTokens.length * 0.75)
    ) {
      return { status: 'lost', items: null, preservedItems: 0, affectedItems: items.length };
    }

    const affectedIndexes = new Set();
    const parentIndexes = Array.from({ length: items.length }, (_, index) => index);
    const findParent = (index) => {
      let root = index;
      while (parentIndexes[root] !== root) root = parentIndexes[root];
      while (parentIndexes[index] !== index) {
        const next = parentIndexes[index];
        parentIndexes[index] = root;
        index = next;
      }
      return root;
    };
    const unionItems = (left, right) => {
      const leftRoot = findParent(left);
      const rightRoot = findParent(right);
      if (leftRoot === rightRoot) return;
      parentIndexes[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
    };
    const indexesForSourceRange = (sourceStart, sourceEnd) => (
      sourceStart < sourceEnd
        ? spans
          .map((span, index) => ({ span, index }))
          .filter(({ span }) => span.end > sourceStart && span.start < sourceEnd)
          .map(({ index }) => index)
        : []
    );
    const insertionItemIndex = (position) => {
      if (position <= spans[0].start) return 0;
      const lastIndex = spans.length - 1;
      if (position >= spans[lastIndex].end) return lastIndex;
      for (let index = 0; index < spans.length; index += 1) {
        const span = spans[index];
        if (span.start < position && position < span.end) return index;
        // 插入在 item 边界时归到前一个 item，避免无关的后一个 item 也被合并。
        if (position === span.start) return Math.max(0, index - 1);
      }
      return lastIndex;
    };
    opcodes.forEach((opcode) => {
      if (opcode.tag === 'equal') return;
      const indexes = indexesForSourceRange(opcode.sourceStart, opcode.sourceEnd);
      if (!indexes.length) {
        const index = insertionItemIndex(opcode.sourceStart);
        if (Number.isInteger(index)) indexes.push(index);
      }
      indexes.forEach((index) => affectedIndexes.add(index));
      for (let index = 1; index < indexes.length; index += 1) {
        unionItems(indexes[0], indexes[index]);
      }
    });
    if (!affectedIndexes.size) {
      return { status: 'lost', items: null, preservedItems: 0, affectedItems: items.length };
    }

    const componentsByRoot = new Map();
    affectedIndexes.forEach((index) => {
      const root = findParent(index);
      const component = componentsByRoot.get(root);
      if (component) {
        component.start = Math.min(component.start, index);
        component.end = Math.max(component.end, index);
      } else {
        componentsByRoot.set(root, { start: index, end: index });
      }
    });
    const components = [...componentsByRoot.values()];
    const componentIds = new Map();
    [...componentsByRoot.keys()].forEach((root, componentId) => {
      componentIds.set(root, componentId);
    });
    const itemOwnerKey = (index) => {
      const componentId = componentIds.get(findParent(index));
      return componentId === undefined ? `item:${index}` : `affected:${componentId}`;
    };

    const targetKeys = [];
    for (const opcode of opcodes) {
      if (opcode.tag === 'equal') {
        for (let sourceIndex = opcode.sourceStart; sourceIndex < opcode.sourceEnd; sourceIndex += 1) {
          const itemIndex = spans.findIndex((span) => span.start <= sourceIndex && sourceIndex < span.end);
          if (itemIndex < 0) {
            return { status: 'lost', items: null, preservedItems: 0, affectedItems: items.length };
          }
          targetKeys.push(itemOwnerKey(itemIndex));
        }
        continue;
      }
      if (opcode.targetStart >= opcode.targetEnd) continue;
      const indexes = indexesForSourceRange(opcode.sourceStart, opcode.sourceEnd);
      if (!indexes.length) {
        const index = insertionItemIndex(opcode.sourceStart);
        if (Number.isInteger(index)) indexes.push(index);
      }
      if (!indexes.length) {
        return { status: 'lost', items: null, preservedItems: 0, affectedItems: items.length };
      }
      const ownerKey = itemOwnerKey(indexes[0]);
      for (let targetIndex = opcode.targetStart; targetIndex < opcode.targetEnd; targetIndex += 1) {
        targetKeys.push(ownerKey);
      }
    }

    const runs = [];
    targetKeys.forEach((key, index) => {
      const previous = runs[runs.length - 1];
      if (previous?.key === key) previous.end = index + 1;
      else runs.push({ key, start: index, end: index + 1 });
    });
    const usedKeys = new Set();
    const reconciled = [];
    for (const run of runs) {
      if (usedKeys.has(run.key)) {
        return { status: 'lost', items: null, preservedItems: 0, affectedItems: items.length };
      }
      usedKeys.add(run.key);
      const text = newTokens.slice(run.start, run.end).join('');
      if (!text) continue;
      let item;
      if (run.key.startsWith('item:')) {
        item = cloneJsonValue(items[Number(run.key.slice(5))]);
      } else {
        const component = components[Number(run.key.slice(9))];
        item = cloneJsonValue(items[component.start]);
        item.start = items[component.start].start;
        item.end = items[component.end].end;
      }
      item.text = text;
      reconciled.push(item);
    }
    if (reconciled.length && reconciled.map((item) => item.text).join('') === newText) {
      return {
        status: 'partial',
        items: reconciled,
        preservedItems: reconciled.length,
        affectedItems: affectedIndexes.size,
      };
    }
    return { status: 'lost', items: null, preservedItems: 0, affectedItems: items.length };
  }

  function buildTimedTextEditReportFixed(segments, draftTexts) {
    const source = Array.isArray(segments) ? segments : [];
    const texts = Array.isArray(draftTexts) ? draftTexts : [];
    const valid = source.length === texts.length;
    const boundaryPlan = buildTimedTextBoundaryPlan(source, texts);
    const rows = source.map((segment, index) => {
      const before = String(segment?.text == null ? '' : segment.text);
      const after = String(texts[index] == null ? '' : texts[index]);
      const diff = buildTimedTextDiff(before, after);
      const boundary = boundaryPlan.updates[index];
      const mapping = boundary
        ? {
          status: 'boundary',
          items: boundary.items,
          preservedItems: boundary.items.length,
          affectedItems: boundary.items.length,
        }
        : reconcileTimedTextItems(before, segment?.items, after);
      const afterStart = boundary ? boundary.start : Number(segment?.start);
      const afterEnd = boundary ? boundary.end : Number(segment?.end);
      const coverage = timedTextItemCoverage(after, mapping.items);
      const reuse = timedTextItemReuse(
        before, segment?.items, after, mapping.items, mapping.status,
      );
      return {
        index,
        before,
        after,
        changed: before !== after,
        deleted: Boolean(before.trim() && !after.trim()),
        diff,
        mappingStatus: mapping.status,
        beforeItemCount: Array.isArray(segment?.items) ? segment.items.length : 0,
        afterItemCount: mapping.items?.length || 0,
        preservedItems: mapping.preservedItems,
        affectedItems: mapping.affectedItems,
        items: mapping.items,
        itemCoverage: coverage.percent,
        itemCoverageData: coverage,
        itemReuse: reuse.percent,
        itemReuseData: reuse,
        beforeStart: Number(segment?.start),
        beforeEnd: Number(segment?.end),
        afterStart,
        afterEnd,
        timingChanged: afterStart !== Number(segment?.start) || afterEnd !== Number(segment?.end),
      };
    });
    const changedRows = rows.filter((row) => row.changed);
    const stats = {
      totalSegments: source.length,
      changedSegments: changedRows.length,
      unchangedSegments: rows.length - changedRows.length,
      beforeCharacters: rows.reduce((sum, row) => sum + timedTextTokens(row.before).length, 0),
      afterCharacters: rows.reduce((sum, row) => sum + timedTextTokens(row.after).length, 0),
      addedCharacters: changedRows.reduce((sum, row) => sum + row.diff.addedCharacters, 0),
      removedCharacters: changedRows.reduce((sum, row) => sum + row.diff.removedCharacters, 0),
      fullMappedCues: changedRows.filter((row) => row.mappingStatus === 'full').length,
      partialMappedCues: changedRows.filter((row) => row.mappingStatus === 'partial').length,
      lostMappedCues: changedRows.filter((row) => row.mappingStatus === 'lost').length,
      unavailableMappedCues: changedRows.filter((row) => row.mappingStatus === 'unavailable').length,
      boundaryMappedCues: changedRows.filter((row) => row.mappingStatus === 'boundary').length,
      boundaryMoves: boundaryPlan.transfers.length,
      timingChangedCues: rows.filter((row) => row.timingChanged).length,
      preservedItems: changedRows.reduce((sum, row) => sum + row.preservedItems, 0),
      affectedItems: changedRows.reduce((sum, row) => sum + row.affectedItems, 0),
    };
    return { valid, rows, changedRows, stats, boundaryMoves: boundaryPlan.transfers };
  }

  function timedTextStructureSourceSlice(source, range) {
    const sourceSegments = Array.isArray(source) ? source : [];
    const requestedStart = Math.max(0, Math.round(Number(range?.start) || 0));
    const requestedEnd = Math.max(requestedStart, Math.round(Number(range?.end) || 0));
    const textParts = [];
    const items = [];
    let offset = 0;
    sourceSegments.forEach((segment) => {
      const tokens = timedTextTokens(segment?.text);
      const sourceStart = offset;
      const sourceEnd = offset + tokens.length;
      offset = sourceEnd;
      const localStart = Math.max(0, requestedStart - sourceStart);
      const localEnd = Math.min(tokens.length, requestedEnd - sourceStart);
      if (localStart >= localEnd) return;
      textParts.push(tokens.slice(localStart, localEnd).join(''));
      const layout = timedTextItemLayout(segment?.text, segment?.items);
      if (layout) {
        const sliced = timedTextItemsSlice(layout, localStart, localEnd);
        if (sliced) items.push(...sliced);
      }
    });
    return { text: textParts.join(''), items };
  }

  function buildTimedTextStructureReport(source, texts, plan) {
    const outputRows = plan.segments.map((output, outputIndex) => {
      const meta = plan.outputMeta[outputIndex] || { sourceIndexes: [], range: null };
      const sourceSlice = timedTextStructureSourceSlice(source, meta.range);
      const sourceIndexes = Array.isArray(meta.sourceIndexes) ? meta.sourceIndexes : [];
      const structural = sourceIndexes.some((index) => plan.affectedSourceIndexes.includes(index))
        || sourceIndexes.length !== 1;
      // 结构拆分时，每个输出行只对应原字幕的一段时间范围，但“修改前”
      // 应该展示用户实际拆分的整条原字幕，而不是展示与“修改后”相同的切片。
      // 例如「超高速摄影机」拆成「超高速」/「摄影机」时，两行都以整句为 before。
      const fullSourceText = sourceIndexes
        .map((index) => String(source[index]?.text == null ? '' : source[index].text))
        .join('');
      const before = structural && fullSourceText ? fullSourceText : sourceSlice.text;
      const after = String(output?.text || '');
      const mappingStatus = structural
        ? 'structure'
        : reconcileTimedTextItems(before, sourceSlice.items, after).status;
      const coverage = timedTextItemCoverage(after, output?.items);
      const reuse = timedTextItemReuse(
        before,
        sourceSlice.items,
        after,
        output?.items,
        before === after ? 'full' : mappingStatus,
      );
      return {
        index: outputIndex,
        draftIndex: meta.draftIndex,
        sourceIndexes,
        before,
        after,
        changed: before !== after || structural,
        deleted: false,
        structureChanged: structural,
        diff: buildTimedTextDiff(before, after),
        mappingStatus,
        beforeItemCount: sourceSlice.items.length,
        afterItemCount: Array.isArray(output?.items) ? output.items.length : 0,
        preservedItems: Array.isArray(output?.items) ? output.items.length : 0,
        affectedItems: Array.isArray(output?.items) ? output.items.length : 0,
        items: output?.items,
        itemCoverage: coverage.percent,
        itemCoverageData: coverage,
        itemReuse: reuse.percent,
        itemReuseData: reuse,
        beforeStart: sourceSlice.items[0]?.start ?? Number(output?.start),
        beforeEnd: sourceSlice.items[sourceSlice.items.length - 1]?.end ?? Number(output?.end),
        afterStart: Number(output?.start),
        afterEnd: Number(output?.end),
        timingChanged: structural,
        timingEstimated: meta.timingEstimated === true,
      };
    });
    const rows = source.map((segment, index) => {
      const outputIndexes = plan.sourceOutputIndexes[index] || [];
      const outputs = outputIndexes.map((outputIndex) => plan.segments[outputIndex]).filter(Boolean);
      const before = String(segment?.text == null ? '' : segment.text);
      const after = outputs.map((output) => String(output?.text || '')).join('');
      const affected = plan.affectedSourceIndexes.includes(index);
      const diff = buildTimedTextDiff(before, after);
      const items = outputs.flatMap((output) => Array.isArray(output?.items) ? output.items : []);
      const mappingStatus = affected ? 'structure' : reconcileTimedTextItems(before, segment?.items, after).status;
      const coverage = timedTextItemCoverage(after, items);
      const reuse = timedTextItemReuse(
        before, segment?.items, after, items, mappingStatus,
      );
      const firstOutput = outputs[0];
      const lastOutput = outputs[outputs.length - 1];
      const afterStart = firstOutput ? Number(firstOutput.start) : Number(segment?.start);
      const afterEnd = lastOutput ? Number(lastOutput.end) : Number(segment?.end);
      return {
        index,
        before,
        after,
        displayAfter: outputs.map((output) => String(output?.text || '')).join('\n'),
        changed: before !== after || affected,
        deleted: Boolean(before.trim() && !after.trim()),
        structureChanged: affected,
        diff,
        mappingStatus,
        beforeItemCount: Array.isArray(segment?.items) ? segment.items.length : 0,
        afterItemCount: items.length,
        preservedItems: items.length,
        affectedItems: items.length,
        items,
        itemCoverage: coverage.percent,
        itemCoverageData: coverage,
        itemReuse: reuse.percent,
        itemReuseData: reuse,
        beforeStart: Number(segment?.start),
        beforeEnd: Number(segment?.end),
        afterStart,
        afterEnd,
        timingChanged: affected
          || afterStart !== Number(segment?.start) || afterEnd !== Number(segment?.end),
      };
    });
    const changedRows = rows.filter((row) => row.changed);
    const stats = {
      ...buildTimedTextEditReportFixed(source, source.map((segment) => segment?.text || '')).stats,
      totalSegments: source.length,
      changedSegments: changedRows.length,
      unchangedSegments: rows.length - changedRows.length,
      beforeCharacters: rows.reduce((sum, row) => sum + timedTextTokens(row.before).length, 0),
      afterCharacters: rows.reduce((sum, row) => sum + timedTextTokens(row.after).length, 0),
      addedCharacters: changedRows.reduce((sum, row) => sum + row.diff.addedCharacters, 0),
      removedCharacters: changedRows.reduce((sum, row) => sum + row.diff.removedCharacters, 0),
      fullMappedCues: changedRows.filter((row) => row.mappingStatus === 'full').length,
      partialMappedCues: changedRows.filter((row) => row.mappingStatus === 'partial').length,
      lostMappedCues: changedRows.filter((row) => row.mappingStatus === 'lost').length,
      unavailableMappedCues: changedRows.filter((row) => row.mappingStatus === 'unavailable').length,
      boundaryMappedCues: 0,
      boundaryMoves: 0,
      timingChangedCues: rows.filter((row) => row.timingChanged).length,
      preservedItems: changedRows.reduce((sum, row) => sum + row.preservedItems, 0),
      affectedItems: changedRows.reduce((sum, row) => sum + row.affectedItems, 0),
      structureMappedCues: changedRows.filter((row) => row.mappingStatus === 'structure').length,
      estimatedTimingCues: outputRows.filter((row) => row.timingEstimated).length,
    };
    return {
      valid: true,
      rows,
      changedRows,
      stats,
      boundaryMoves: [],
      structure: plan,
      previewSegments: plan.segments,
      outputRows,
    };
  }

  function buildTimedTextEditReport(segments, draftTexts) {
    const source = Array.isArray(segments) ? segments : [];
    const texts = Array.isArray(draftTexts) ? draftTexts : [];
    if (timedTextStructureRequested(source, texts)) {
      const plan = buildTimedTextStructurePlan(source, texts);
      if (plan.valid) return buildTimedTextStructureReport(source, texts, plan);
      return {
        ...buildTimedTextEditReportFixed(source, texts),
        structure: plan,
        previewSegments: [],
      };
    }
    return buildTimedTextEditReportFixed(source, texts);
  }

  function timedTextEditComparableSegment(segment) {
    const comparable = cloneJsonValue(segment || {});
    if (comparable && typeof comparable === 'object') delete comparable._dirty;
    return comparable;
  }

  function timedTextEditSegmentsEquivalent(sourceSegment, outputSegment) {
    return JSON.stringify(timedTextEditComparableSegment(sourceSegment))
      === JSON.stringify(timedTextEditComparableSegment(outputSegment));
  }

  // 结构编辑会返回一组新的 segments，但不能因此把所有输出行都标成 dirty。
  // 只有内容/时间范围/结构确实发生变化的输出，或来自本来就 dirty 的来源行，
  // 才应继续显示 dirty；原样保留的一对一字幕沿用来源行的 dirty 状态。
  function timedTextEditDirtyFlags(sourceSegments, nextSegments, report) {
    const source = Array.isArray(sourceSegments) ? sourceSegments : [];
    const next = Array.isArray(nextSegments) ? nextSegments : [];
    const structure = report?.structure?.valid === true ? report.structure : null;
    if (!structure) {
      return next.map((segment, index) => {
        const sourceSegment = source[index];
        const row = report?.rows?.[index];
        if (!sourceSegment || row?.changed || row?.timingChanged) return true;
        return sourceSegment._dirty === true;
      });
    }

    const affectedSourceIndexes = new Set(structure.affectedSourceIndexes || []);
    const sourceOutputIndexes = Array.isArray(structure.sourceOutputIndexes)
      ? structure.sourceOutputIndexes : [];
    return next.map((segment, outputIndex) => {
      const meta = structure.outputMeta?.[outputIndex];
      const sourceIndexes = Array.isArray(meta?.sourceIndexes) ? meta.sourceIndexes : [];
      const sourceIndex = sourceIndexes.length === 1 ? sourceIndexes[0] : -1;
      const sourceSegment = sourceIndex >= 0 ? source[sourceIndex] : null;
      const outputIndexes = sourceIndex >= 0 ? sourceOutputIndexes[sourceIndex] || [] : [];
      const unchanged = Boolean(sourceSegment)
        && sourceIndexes.length === 1
        && outputIndexes.length === 1
        && outputIndexes[0] === outputIndex
        && !affectedSourceIndexes.has(sourceIndex)
        && timedTextEditSegmentsEquivalent(sourceSegment, segment);
      return unchanged ? sourceSegment._dirty === true : true;
    });
  }

  function applyTimedTextEdit(segments, draftTexts) {
    const source = Array.isArray(segments) ? segments : [];
    const texts = Array.isArray(draftTexts) ? draftTexts : [];
    if (timedTextStructureRequested(source, texts)) {
      const structurePlan = buildTimedTextStructurePlan(source, texts);
      return structurePlan.valid ? cloneJsonValue(structurePlan.segments) : null;
    }
    if (source.length !== texts.length) return null;
    const boundaryPlan = buildTimedTextBoundaryPlan(source, texts);
    return source.flatMap((segment, index) => {
      const next = cloneJsonValue(segment || {});
      const before = String(next.text == null ? '' : next.text);
      const after = String(texts[index] == null ? '' : texts[index]);
      if (before === after) return next;
      if (!after) return [];
      const boundary = boundaryPlan.updates[index];
      if (boundary) {
        next.text = after;
        next.start = boundary.start;
        next.end = boundary.end;
        if (boundary.items.length) next.items = cloneJsonValue(boundary.items);
        else delete next.items;
        return next;
      }
      const mapping = reconcileTimedTextItems(before, next.items, after);
      next.text = after;
      if (mapping.status === 'full' || mapping.status === 'partial') next.items = mapping.items;
      else if (mapping.status === 'lost') delete next.items;
      return next;
    });
  }

  function countTextUnits(text) {
    const normalized = String(text || '').replace(/\r\n?/g, '').replace(/\n/g, '');
    let total = 0;
    for (const ch of normalized) total += ch.codePointAt(0) < 256 ? 0.5 : 1;
    return total;
  }

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

  // 时长兜底（与 maw/project.py 的 repair_segment_durations 同规则，原地修改）：
  // 任何 0 长（或倒挂）的段 / item 至少保留 minMs，且保持单调不重叠、item 不越出
  // 所属段。只修改非法值，本已合法的短时长时间码（如真实的 60ms 词）保持不动。
  // 返回修复的边界数量。
  function normalizeSegmentTimings(segments, minMs = 100) {
    const floor = Math.max(1, Math.round(Number(minMs) || 100));
    const source = Array.isArray(segments) ? segments : [];
    let fixed = 0;
    let previousSegmentEnd = 0;
    source.forEach((segment) => {
      if (!segment || typeof segment !== 'object') return;
      let start = Math.round(Number(segment.start));
      let end = Math.round(Number(segment.end));
      if (!Number.isFinite(start)) start = 0;
      if (!Number.isFinite(end)) end = start;
      if (start < previousSegmentEnd) { start = previousSegmentEnd; fixed++; }
      fixed += normalizeTimedTextNeutralItems(segment);
      const items = Array.isArray(segment.items) ? segment.items : null;
      let previousItemEnd = start;
      if (items) {
        items.forEach((item) => {
          if (!item || typeof item !== 'object') return;
          let itemStart = Math.round(Number(item.start));
          let itemEnd = Math.round(Number(item.end));
          if (!Number.isFinite(itemStart)) itemStart = previousItemEnd;
          if (!Number.isFinite(itemEnd)) itemEnd = itemStart;
          if (itemStart < previousItemEnd) { itemStart = previousItemEnd; fixed++; }
          if (itemEnd <= itemStart) { itemEnd = itemStart + floor; fixed++; }
          item.start = itemStart;
          item.end = itemEnd;
          previousItemEnd = itemEnd;
        });
        const lastEnd = items.length ? items[items.length - 1].end : null;
        if (Number.isFinite(lastEnd) && end < lastEnd) { end = lastEnd; fixed++; }
      }
      if (end <= start) { end = start + floor; fixed++; }
      segment.start = start;
      segment.end = end;
      previousSegmentEnd = end;
    });
    return fixed;
  }

  // 保存前只修复段内 item 的顺序和零时长，不改动字幕段本身的范围。
  // 这样可以自动处理波形取整造成的 1ms 字/词时间码重叠，同时把真正的
  // 字幕段重叠交给服务端严格校验。
  function normalizeItemTimingRanges(segments, minMs = 100) {
    const floor = Math.max(1, Math.round(Number(minMs) || 100));
    const source = Array.isArray(segments) ? segments : [];
    let fixed = 0;
    source.forEach((segment) => {
      if (!segment || typeof segment !== 'object') return;
      fixed += normalizeTimedTextNeutralItems(segment);
      let previousItemEnd = Math.round(Number(segment.start));
      if (!Number.isFinite(previousItemEnd)) previousItemEnd = 0;
      const items = Array.isArray(segment.items) ? segment.items : null;
      if (!items) return;
      items.forEach((item) => {
        if (!item || typeof item !== 'object') return;
        let itemStart = Math.round(Number(item.start));
        let itemEnd = Math.round(Number(item.end));
        if (!Number.isFinite(itemStart)) { itemStart = previousItemEnd; fixed++; }
        if (!Number.isFinite(itemEnd)) { itemEnd = itemStart; fixed++; }
        if (itemStart < previousItemEnd) { itemStart = previousItemEnd; fixed++; }
        if (itemEnd <= itemStart) { itemEnd = itemStart + floor; fixed++; }
        item.start = itemStart;
        item.end = itemEnd;
        previousItemEnd = itemEnd;
      });
    });
    return fixed;
  }

  // 帧模式下，多个字词可能因为帧率取整而落在同一帧。它们的 frame
  // 字段可以合法地重合，但保存用的毫秒兼容字段仍必须保持在字幕段内、
  // 按 item 顺序排列；不能交给通用修复器按 100ms 向后扩张。
  // 尽量保留帧投影出的毫秒范围，发生碰撞时只压缩到段内剩余空间。
  function normalizeFrameItemTimingRanges(segment) {
    if (!segment || typeof segment !== 'object' || !Array.isArray(segment.items)) return 0;
    const segmentStart = Math.round(Number(segment.start));
    const segmentEnd = Math.round(Number(segment.end));
    if (!Number.isFinite(segmentStart) || !Number.isFinite(segmentEnd)
        || segmentEnd < segmentStart) return 0;

    const items = segment.items.filter((item) => item && typeof item === 'object');
    const minimumDuration = segmentEnd - segmentStart >= items.length ? 1 : 0;
    let previousItemEnd = segmentStart;
    let processed = 0;
    let fixed = 0;
    segment.items.forEach((item) => {
      if (!item || typeof item !== 'object') return;
      const rawStart = Number(item.start);
      const rawEnd = Number(item.end);
      const candidateStart = Number.isFinite(rawStart)
        ? Math.round(rawStart) : previousItemEnd;
      const candidateEnd = Number.isFinite(rawEnd)
        ? Math.round(rawEnd) : candidateStart;
      const remainingItems = items.length - processed - 1;
      const latestEnd = segmentEnd - minimumDuration * remainingItems;
      const latestStart = latestEnd - minimumDuration;
      const itemStart = Math.min(
        Math.max(candidateStart, previousItemEnd, segmentStart),
        latestStart,
      );
      const itemEnd = Math.min(
        Math.max(candidateEnd, itemStart + minimumDuration),
        latestEnd,
      );
      if (item.start !== itemStart || item.end !== itemEnd) fixed += 1;
      item.start = itemStart;
      item.end = itemEnd;
      previousItemEnd = itemEnd;
      processed += 1;
    });
    return fixed;
  }

  function timedItemsFitSegmentRange(segment, start, end) {
    const items = Array.isArray(segment?.items) ? segment.items : null;
    if (!items) return true;
    let previousEnd = start;
    return items.every((item) => {
      const itemStart = Number(item?.start);
      const itemEnd = Number(item?.end);
      const valid = Number.isInteger(itemStart)
        && Number.isInteger(itemEnd)
        && itemStart >= start
        && itemEnd <= end
        && itemStart >= previousEnd
        && itemEnd > itemStart;
      if (valid) previousEnd = itemEnd;
      return valid;
    });
  }

  // 修复一处相邻字幕段的时间重叠。默认把后句起点吸附到前句终点；
  // 也可以显式选择缩短前句。只修改指定的一对字幕，不静默重排后续时间轴。
  // 如果边界移动会让目标段的 items 越界，则删除该段 items，保留字幕段整体时间。
  function repairSegmentOverlap(segments, index, mode = 'shift-current') {
    const source = Array.isArray(segments) ? segments : [];
    const currentIndex = Number(index);
    if (!Number.isInteger(currentIndex) || currentIndex <= 0 || currentIndex >= source.length) {
      return { changed: false, reason: 'invalid-index', overlapMs: 0 };
    }
    const previous = source[currentIndex - 1];
    const current = source[currentIndex];
    if (!previous || typeof previous !== 'object' || !current || typeof current !== 'object') {
      return { changed: false, reason: 'invalid-segment', overlapMs: 0 };
    }
    const previousStart = Math.round(Number(previous.start));
    const previousEnd = Math.round(Number(previous.end));
    const currentStart = Math.round(Number(current.start));
    const currentEnd = Math.round(Number(current.end));
    const overlapMs = Number.isFinite(previousEnd) && Number.isFinite(currentStart)
      ? previousEnd - currentStart : 0;
    if (!Number.isFinite(overlapMs) || overlapMs <= 0) {
      return { changed: false, reason: 'no-overlap', overlapMs: Math.max(0, overlapMs || 0) };
    }

    const trimPrevious = mode === 'trim-previous';
    const target = trimPrevious ? previous : current;
    const nextStart = trimPrevious ? previousStart : previousEnd;
    const nextEnd = trimPrevious ? currentStart : currentEnd;
    if (!Number.isFinite(nextStart) || !Number.isFinite(nextEnd) || nextEnd <= nextStart) {
      return { changed: false, reason: 'no-room', overlapMs };
    }
    const clearsItems = Array.isArray(target.items)
      && target.items.length > 0
      && !timedItemsFitSegmentRange(target, nextStart, nextEnd);
    if (trimPrevious) target.end = nextEnd;
    else target.start = nextStart;
    if (clearsItems) delete target.items;
    target._dirty = true;
    return {
      changed: true,
      mode: trimPrevious ? 'trim-previous' : 'shift-current',
      overlapMs,
      changedIndices: [trimPrevious ? currentIndex - 1 : currentIndex],
      itemsCleared: clearsItems,
    };
  }

  // 拼合字幕计划（纯函数，不改动输入）。返回：
  // - snaps: [{ index, edge, time }]，相邻间隔在 (0, gapMs] 时：
  //   snapDirection 'backward'（向前拓展，默认）把后方字幕 start 前拓到前一条 end；
  //   snapDirection 'forward'（向后拓展）把前方字幕 end 后延到后一条 start。
  // - groups: [[idx, ...]]，过短字幕的合并组；absorbDirection 'previous'（向前吸收，
  //   默认）并入上一条、'next'（向后吸收）并入下一条；absorbShort 为 false 时不合并。
  //   吸收同样要求两条字幕的实际间隔在 [0, gapMs] 内；禁用项或 speaker 不一致的组合不合并。
  function planAutoMerge(segments, options = {}) {
    const gapMs = Math.max(0, Math.round(Number(options.gapMs) || 0));
    const snapDirection = options.snapDirection === 'forward' ? 'forward' : 'backward';
    const absorbShort = options.absorbShort !== false;
    const absorbDirection = options.absorbDirection === 'next' ? 'next' : 'previous';
    const shortCount = Math.max(1, Math.round(Number(options.shortCount) || 3));
    const source = Array.isArray(segments) ? segments : [];
    const snaps = [];
    for (let i = 1; i < source.length; i++) {
      const previous = source[i - 1];
      const current = source[i];
      if (!previous || !current) continue;
      if (!Number.isFinite(previous.end) || !Number.isFinite(current.start)) continue;
      const gap = current.start - previous.end;
      if (gap <= 0 || gap > gapMs) continue;
      if (snapDirection === 'forward') snaps.push({ index: i - 1, edge: 'end', time: current.start });
      else snaps.push({ index: i, edge: 'start', time: previous.end });
    }
    const canMergePair = (leftIdx, rightIdx) => {
      const left = source[leftIdx];
      const right = source[rightIdx];
      if (!left || !right) return false;
      if (left.disabled || right.disabled) return false;
      if (!Number.isFinite(left.end) || !Number.isFinite(right.start)) return false;
      const gap = right.start - left.end;
      if (gap < 0 || gap > gapMs) return false;
      return (left.speaker ?? null) === (right.speaker ?? null);
    };
    const groups = [];
    if (absorbShort) {
      const indexRange = (from, to) => Array.from({ length: to - from + 1 }, (_, k) => from + k);
      let i = 0;
      while (i < source.length) {
        if (!isShortSubtitleText(source[i]?.text, shortCount)) { i++; continue; }
        // 连续过短字幕区间 [i..j]（相邻短字幕之间也要满足合并条件）
        let j = i;
        while (j + 1 < source.length
            && isShortSubtitleText(source[j + 1]?.text, shortCount)
            && canMergePair(j, j + 1)) j++;
        const lastGroup = groups[groups.length - 1];
        const canExtendLast = !!(lastGroup && lastGroup[lastGroup.length - 1] === i - 1 && canMergePair(i - 1, i));
        const canMergeBackward = i > 0 && canMergePair(i - 1, i);
        const canMergeForward = j + 1 < source.length && canMergePair(j, j + 1);
        if (absorbDirection === 'next') {
          // 向后吸收：优先并入下一条；没有下一条（或不可合并）时退回上一条
          if (canMergeForward) groups.push(indexRange(i, j + 1));
          else if (canExtendLast) for (let k = i; k <= j; k++) lastGroup.push(k);
          else if (canMergeBackward) groups.push(indexRange(i - 1, j));
        } else {
          // 向前吸收：优先并入上一条；首条（或上一条不可合并）时退回下一条
          if (canExtendLast) for (let k = i; k <= j; k++) lastGroup.push(k);
          else if (canMergeBackward) groups.push(indexRange(i - 1, j));
          else if (canMergeForward) groups.push(indexRange(i, j + 1));
        }
        i = j + 1;
      }
    }
    return { snaps, groups };
  }

  // 应用拼合间隔计划（原地修改 segments）：向前拓展把后方字幕 start 前拓到前一条
  // end；向后拓展把前方字幕 end 后延到后一条 start。只许延长、不许缩短。
  // 返回实际改动的字幕条数。
  function applyAutoMergeSnaps(segments, snaps) {
    const source = Array.isArray(segments) ? segments : [];
    let changed = 0;
    (Array.isArray(snaps) ? snaps : []).forEach((snap) => {
      const segment = source[snap?.index];
      if (!segment || !Number.isFinite(snap.time)) return;
      if (snap.edge === 'end') {
        if (snap.time > segment.end) {
          segment.end = snap.time;
          segment._dirty = true;
          changed++;
        }
      } else if (snap.time >= 0 && snap.time < segment.start) {
        segment.start = snap.time;
        segment._dirty = true;
        changed++;
      }
    });
    return changed;
  }

  // 延长字幕计划（纯函数，不改动输入）：先把选中字幕的起点向前延长，
  // 再把终点向后延长。两侧都只使用相邻字幕当前的边界和媒体时长作为上限，
  // 因而不会越过其它字幕或媒体末尾；延长时不触碰段内 items 的绝对时间码。
  // 返回每条字幕的实际前/后延长量，供 UI 统计“完整 / 部分 / 未延长”。
  function planSubtitleExtension(segments, indices, options = {}) {
    const source = Array.isArray(segments) ? segments : [];
    const requestedIndices = indices == null
      ? []
      : Array.from(indices || []);
    const targetIndices = (requestedIndices.length ? requestedIndices : source.map((_, index) => index))
      .map((index) => Number(index))
      .filter((index) => Number.isInteger(index) && index >= 0 && index < source.length)
      .filter((index, position, values) => values.indexOf(index) === position)
      .sort((a, b) => a - b);
    const normalizeMs = (value) => {
      const numeric = Number(value);
      return Number.isFinite(numeric) && numeric >= 0 ? Math.round(numeric) : 0;
    };
    const forwardMs = normalizeMs(options.forwardMs);
    const backwardMs = normalizeMs(options.backwardMs);
    const duration = Number(options.durationMs);
    const durationMs = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
    const planned = new Map();

    targetIndices.forEach((index) => {
      const segment = source[index];
      const start = Number(segment?.start);
      const end = Number(segment?.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return;
      planned.set(index, {
        index,
        start,
        end,
        forwardAppliedMs: 0,
        backwardAppliedMs: 0,
      });
    });

    // 向前延长优先：先统一处理所有字幕起点，避免同一次执行的后延改变前拓上限。
    targetIndices.forEach((index) => {
      const change = planned.get(index);
      if (!change || forwardMs <= 0) return;
      const previousEnd = index > 0 ? Number(source[index - 1]?.end) : 0;
      const lowerBound = Number.isFinite(previousEnd) ? Math.max(0, previousEnd) : 0;
      // 已经与前句重叠时不反向缩短当前字幕，只报告为未延长。
      const available = Math.max(0, change.start - lowerBound);
      const applied = Math.min(forwardMs, available);
      if (applied > 0) {
        change.start -= applied;
        change.forwardAppliedMs = applied;
      }
    });

    targetIndices.forEach((index) => {
      const change = planned.get(index);
      if (!change || backwardMs <= 0) return;
      const nextChange = planned.get(index + 1);
      const nextStart = nextChange
        ? nextChange.start
        : index + 1 < source.length
          ? Number(source[index + 1]?.start)
          : durationMs;
      const upperBound = Number.isFinite(nextStart) ? nextStart : durationMs;
      // 已经与后句重叠时不反向缩短当前字幕，只报告为未延长。
      const available = Math.max(0, upperBound - change.end);
      const applied = Math.min(backwardMs, available);
      if (applied > 0) {
        change.end += applied;
        change.backwardAppliedMs = applied;
      }
    });

    const changes = [...planned.values()].filter((change) => (
      change.start !== Number(source[change.index]?.start)
      || change.end !== Number(source[change.index]?.end)
    )).map((change) => {
      const forwardPartial = forwardMs > 0 && change.forwardAppliedMs < forwardMs;
      const backwardPartial = backwardMs > 0 && change.backwardAppliedMs < backwardMs;
      const partial = forwardPartial || backwardPartial;
      return {
        ...change,
        changed: change.forwardAppliedMs > 0 || change.backwardAppliedMs > 0,
        partial,
      };
    });
    const changedIndices = changes.filter((change) => change.changed).map((change) => change.index);
    return {
      indices: targetIndices,
      changes,
      changedIndices,
      fullCount: changes.filter((change) => change.changed && !change.partial).length,
      partialCount: changes.filter((change) => change.changed && change.partial).length,
      unchangedCount: targetIndices.length - changedIndices.length,
      forwardMs,
      backwardMs,
    };
  }

  function applySubtitleExtension(segments, indices, options = {}) {
    const source = Array.isArray(segments) ? segments : [];
    const plan = planSubtitleExtension(source, indices, options);
    plan.changes.forEach((change) => {
      const segment = source[change.index];
      if (!segment || !change.changed) return;
      segment.start = change.start;
      segment.end = change.end;
      segment._dirty = true;
    });
    return plan;
  }

  function formatHumanDuration(durationMs) {
    const totalSeconds = Math.max(0, Math.floor(Number(durationMs) / 1000) || 0);
    const seconds = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    if (totalMinutes < 1) return `${totalSeconds}秒`;
    const minutes = totalMinutes % 60;
    const hours = Math.floor(totalMinutes / 60);
    if (hours < 1) return `${minutes}分${seconds ? `${seconds}秒` : ''}`;
    return `${hours}小时${minutes ? `${minutes}分` : ''}${seconds ? `${seconds}秒` : ''}`;
  }

  function formatGapRemoveDuration(removedMs, mediaDurationMs) {
    const durationLabel = formatHumanDuration(removedMs);
    const mediaDuration = Number(mediaDurationMs);
    if (!Number.isFinite(mediaDuration) || mediaDuration <= 0) return durationLabel;
    const percentage = Math.min(100, Math.max(0, (Number(removedMs) / mediaDuration) * 100));
    const percentageLabel = Number(percentage.toFixed(1)).toString();
    return `${durationLabel}（占比 ${percentageLabel}%）`;
  }

  function timestampedSplitCandidates(segment) {
    const text = String(segment?.text || '');
    const codePoints = Array.from(text);
    if (codePoints.length < 2) return [];
    const hasContent = (value) => /[\p{L}\p{N}\p{S}]/u.test(value);

    const alignedItems = [];
    let searchFrom = 0;
    (Array.isArray(segment?.items) ? segment.items : []).forEach((item) => {
      const itemText = String(item?.text || '');
      if (!itemText) return;
      const start = text.indexOf(itemText, searchFrom);
      if (start < 0) return;
      alignedItems.push({ item, start, end: start + itemText.length });
      searchFrom = start + itemText.length;
    });

    const candidates = [];
    for (let index = 1; index < alignedItems.length; index++) {
      const left = alignedItems[index - 1];
      const right = alignedItems[index];
      const offset = right.start;
      if (offset <= 0 || offset >= text.length) continue;
      if (!hasContent(text.slice(0, offset)) || !hasContent(text.slice(offset))) continue;
      const leftEnd = Number(left.item.end);
      const rightStart = Number(right.item.start);
      const hasTimestamp = Number.isFinite(leftEnd) && Number.isFinite(rightStart);
      let boundaryTime = Number.isFinite(leftEnd) && Number.isFinite(rightStart)
        ? (leftEnd + rightStart) / 2
        : Number.isFinite(rightStart) ? rightStart : leftEnd;
      if (!Number.isFinite(boundaryTime)) {
        boundaryTime = Number(segment?.start)
          + ((Number(segment?.end) - Number(segment?.start)) * offset / text.length);
      }
      candidates.push({ offset, time: boundaryTime, hasTimestamp });
    }
    return candidates;
  }

  function hasUsableSplitTimestamps(segment) {
    return timestampedSplitCandidates(segment).some((candidate) => candidate.hasTimestamp);
  }

  function splitCharOffsetAtTime(segment, timeMs) {
    const text = String(segment?.text || '');
    const codePoints = Array.from(text);
    if (codePoints.length < 2) return null;
    const hasContent = (value) => /[\p{L}\p{N}\p{S}]/u.test(value);
    const targetTime = Number(timeMs);
    const candidates = timestampedSplitCandidates(segment);
    if (candidates.length && Number.isFinite(targetTime)) {
      return candidates.reduce((nearest, candidate) => (
        Math.abs(candidate.time - targetTime) < Math.abs(nearest.time - targetTime)
          ? candidate : nearest
      )).offset;
    }

    const offsets = [];
    let utf16Offset = 0;
    codePoints.forEach((character, index) => {
      utf16Offset += character.length;
      if (index < codePoints.length - 1
          && hasContent(text.slice(0, utf16Offset))
          && hasContent(text.slice(utf16Offset))) {
        offsets.push(utf16Offset);
      }
    });
    if (!offsets.length) return null;
    const start = Number(segment?.start);
    const end = Number(segment?.end);
    const ratio = Number.isFinite(targetTime) && Number.isFinite(start) && Number.isFinite(end) && end > start
      ? Math.max(0, Math.min(1, (targetTime - start) / (end - start)))
      : 0.5;
    const index = Math.max(0, Math.min(offsets.length - 1, Math.round(ratio * codePoints.length) - 1));
    return offsets[index] ?? null;
  }

  // 字幕文本与 items 的顺序保持对齐：每个词在原文的所有出现位置中，选
  // 「位置递增且对齐词数最多」的组合（小规模 DP）。不能用贪心 indexOf：
  // 一处失配就整体作废会让拆分切点随人工插入文本的长度漂移（如把 ASR 词
  // 「傲」改写成「Alt(noir)」后，剩下的同字词必须让位、各自落到真实位置）。
  // 返回与 items 等长的数组，对齐成功的元素为
  // { item, itemText, textStart, textEnd }，空文本或找不到的词为 null。
  function alignItemsToText(text, items) {
    const value = String(text || '');
    const list = Array.isArray(items) ? items : [];
    const occurrences = list.map((item) => {
      const itemText = String(item?.text || '');
      const found = [];
      if (itemText) {
        let pos = value.indexOf(itemText);
        while (pos >= 0) {
          found.push(pos);
          pos = value.indexOf(itemText, pos + 1);
        }
      }
      return found;
    });
    // 对齐在拆分时同步执行：超大输入（超长粘贴段 × 高频重复短词）直接放弃
    // 对齐、返回全失配，让拆分走时间/词序落边回退，而不是冻结编辑器。
    // （常规字幕行远低于该阈值；失配回退本身已有词序映射与漂移提示兜底。）
    if (list.length === 0
        || list.length * (value.length + 2) > 2_000_000
        || occurrences.reduce((sum, occ) => sum + occ.length, 0) > 2_000_000) {
      return new Array(list.length).fill(null);
    }
    const memo = new Map();
    const bestFrom = (index, minStart) => {
      if (index >= list.length) return 0;
      const key = `${index}:${minStart}`;
      const cached = memo.get(key);
      if (cached !== undefined) return cached;
      let best = bestFrom(index + 1, minStart);
      const itemText = String(list[index]?.text || '');
      const occ = occurrences[index];
      // bestFrom(i+1, ·) 随 minStart 单调不增，所以最优转移必然是首个
      // >= minStart 的出现位置，二分即可；逐个扫描会让重复短词的 DP
      // 退化为近似立方复杂度。
      let lo = 0;
      let hi = occ.length - 1;
      let pick = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (occ[mid] >= minStart) {
          pick = mid;
          hi = mid - 1;
        } else {
          lo = mid + 1;
        }
      }
      if (pick >= 0) {
        best = Math.max(best, 1 + bestFrom(index + 1, occ[pick] + itemText.length));
      }
      memo.set(key, best);
      return best;
    };
    const result = new Array(list.length).fill(null);
    let minStart = 0;
    for (let index = 0; index < list.length; index++) {
      const itemText = String(list[index]?.text || '');
      if (!itemText) continue;
      const optimum = bestFrom(index, minStart);
      let chosen = -1;
      for (const pos of occurrences[index]) {
        if (pos >= minStart && 1 + bestFrom(index + 1, pos + itemText.length) >= optimum) {
          chosen = pos;
          break;
        }
      }
      if (chosen >= 0) {
        result[index] = { item: list[index], itemText, textStart: chosen, textEnd: chosen + itemText.length };
        minStart = chosen + itemText.length;
      }
    }
    return result;
  }

  // 拆分时在原文里找不到的 item（人工改写过的词）没有可靠的文本位置：
  // 调用方可通过 item.side 显式定侧（结合相邻对齐锚点的文字空位与刀点
  // 相对位置算出），否则按自身时间与切点比较——完全在切点左侧归左、
  // 右侧归右、跨切点归更近的一侧。bounds 给出两侧当前边界时，边界先扩
  // 到包住本侧失配词（如「傲」的语音正是右段文本 Alt(noir) 的发音：右
  // 段起点必须前移到它的 start，否则词会先于段起点、保存时被时间码兜底
  // 二次改写），失配词再钳进最终边界，钳后为空的丢弃（与对齐词的处理
  // 一致）。返回值带调整后的 bounds；未传 bounds 时保持旧行为（只落边
  // 不钳制）。
  function placeUnalignedSplitItems(leftItems, rightItems, items, splitMs, bounds = null) {
    const left = [...(Array.isArray(leftItems) ? leftItems : [])];
    const right = [...(Array.isArray(rightItems) ? rightItems : [])];
    const cut = Number(splitMs);
    if (!Number.isFinite(cut)) {
      return { leftItems: left, rightItems: right, bounds: null };
    }
    const originalLeftEnd = Number(bounds?.leftEndMs);
    const originalRightStart = Number(bounds?.rightStartMs);
    const hasBounds = Number.isFinite(originalLeftEnd) && Number.isFinite(originalRightStart);
    const pending = [];
    (Array.isArray(items) ? items : []).forEach((item) => {
      if (item?.start == null || item?.end == null) return;
      const start = Number(item.start);
      const end = Number(item.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
      const toLeft = item.side === 'left' ? true
        : item.side === 'right' ? false
        : end <= cut ? true
        : start >= cut ? false
        : cut - start < end - cut;
      // side 只参与落边决策，不能带进工程 JSON。
      const { side: _side, ...itemData } = item;
      pending.push({ item: { ...itemData, start, end }, toLeft });
    });
    let leftEnd = originalLeftEnd;
    let rightStart = originalRightStart;
    if (hasBounds && pending.length) {
      for (const entry of pending) {
        if (entry.toLeft) leftEnd = Math.max(leftEnd, entry.item.end);
        else rightStart = Math.min(rightStart, entry.item.start);
      }
      // 病态时间码可能让扩展后的两侧交叉：放弃扩展，保持原边界。
      if (rightStart < leftEnd) {
        leftEnd = originalLeftEnd;
        rightStart = originalRightStart;
      }
    }
    pending.forEach(({ item, toLeft }) => {
      let { start, end } = item;
      if (hasBounds) {
        if (toLeft) end = Math.min(end, leftEnd);
        else start = Math.max(start, rightStart);
        if (end <= start) return;
      }
      const target = toLeft ? left : right;
      let at = target.length;
      while (at > 0 && Number(target[at - 1].start) > start) at -= 1;
      target.splice(at, 0, { ...item, start, end });
    });
    return {
      leftItems: left,
      rightItems: right,
      bounds: hasBounds ? { leftEndMs: leftEnd, rightStartMs: rightStart } : null,
    };
  }

  // 用户下刀时间与拆分边界的偏差：边界包住下刀（落在两侧词的真实静音
  // 空隙内）记 0，空隙再宽也不算漂移；否则取到最近边界的距离。
  // 注意 Number(null) === 0，缺参必须先按 null 拦下，不能只靠 isFinite。
  function splitAlignmentDriftMs(leftEndMs, rightStartMs, requestedCutMs) {
    if (requestedCutMs == null || leftEndMs == null || rightStartMs == null) return null;
    const requested = Number(requestedCutMs);
    const leftEnd = Number(leftEndMs);
    const rightStart = Number(rightStartMs);
    if (!Number.isFinite(requested) || !Number.isFinite(leftEnd) || !Number.isFinite(rightStart)) return null;
    if (requested >= leftEnd && requested <= rightStart) return 0;
    return Math.round(Math.min(Math.abs(requested - leftEnd), Math.abs(requested - rightStart)));
  }

  function findAdjacentCueIndex(segments, currentIndex, direction, skipDisabled = false) {
    for (let index = currentIndex + direction; index >= 0 && index < segments.length; index += direction) {
      if (!skipDisabled || !segments[index]?.disabled) return index;
    }
    return -1;
  }

  function findCueNavigationTarget(segments, currentIndex, timeMs, direction, skipDisabled = false) {
    if (!Array.isArray(segments) || !segments.length || (direction !== -1 && direction !== 1)) return -1;
    if (Number.isInteger(currentIndex) && currentIndex >= 0 && currentIndex < segments.length) {
      return findAdjacentCueIndex(segments, currentIndex, direction, skipDisabled);
    }

    const time = Number(timeMs);
    if (!Number.isFinite(time)) return -1;
    const activeIndex = segments.findIndex((segment, index) => (
      segment && Number(segment.start) <= time && (
        Number(segment.end) > time
        || index === segments.length - 1
        || Number(segments[index + 1]?.start) > time
      )
    ));
    if (activeIndex >= 0) {
      return findAdjacentCueIndex(segments, activeIndex, direction, skipDisabled);
    }

    if (direction < 0) {
      for (let index = segments.length - 1; index >= 0; index -= 1) {
        if (Number(segments[index]?.start) >= time) continue;
        if (!skipDisabled || !segments[index]?.disabled) return index;
      }
      return -1;
    }
    for (let index = 0; index < segments.length; index += 1) {
      if (Number(segments[index]?.start) <= time) continue;
      if (!skipDisabled || !segments[index]?.disabled) return index;
    }
    return -1;
  }

  function findCueSelectionExtensionTarget(
    segments,
    selectedIndexes,
    currentIndex,
    timeMs,
    direction,
    skipDisabled = false,
  ) {
    if (!Array.isArray(segments) || !segments.length || (direction !== -1 && direction !== 1)) return -1;
    const selected = Array.from(selectedIndexes || [])
      .filter((index) => Number.isInteger(index) && index >= 0 && index < segments.length);
    if (!selected.length) {
      return findCueNavigationTarget(
        segments,
        currentIndex,
        timeMs,
        direction,
        skipDisabled,
      );
    }
    const edge = direction < 0 ? Math.min(...selected) : Math.max(...selected);
    return findAdjacentCueIndex(segments, edge, direction, skipDisabled);
  }

  function cloneJsonValue(value) {
    return value == null ? null : JSON.parse(JSON.stringify(value));
  }

  const EDITOR_SETTING_ROW_HEIGHTS = [64, 80, 96, 120, 144, 168, 192];
  // 拆分边界符号修剪配置：勾选/填写的符号会在拆分后从两侧文本边缘移除。
  // 空格与换行永远修剪，不参与配置。
  // 仅前 5 个高频符号提供勾选 chip；其余符号由设置面板的自由文本框维护
  // （空格分隔），文本框默认预填半角逗号和句点，延续旧版行为。
  const SPLIT_TRIM_PRIMARY_SYMBOLS = Object.freeze([
    { ch: '，', name: '全角逗号' },
    { ch: '。', name: '句号' },
    { ch: '、', name: '顿号' },
    { ch: '！', name: '全角感叹号' },
    { ch: '？', name: '全角问号' },
  ]);
  const DEFAULT_EXTRA_SPLIT_TRIM_SYMBOLS = Object.freeze([',', '.']);
  const DEFAULT_SPLIT_TRIM_SYMBOLS = Object.freeze(
    [...SPLIT_TRIM_PRIMARY_SYMBOLS.map((option) => option.ch), ...DEFAULT_EXTRA_SPLIT_TRIM_SYMBOLS],
  );

  // 设置面板文本框解析：按空白拆分后把每个片段展开为单字符并去重，
  // 这样「,.」与「, .」等价，减少手动输入格式差异带来的意外。
  function parseSplitTrimSymbolInput(text) {
    const seen = new Set();
    String(text || '').split(/\s+/u).forEach((token) => {
      Array.from(token).forEach((ch) => { if (ch.trim()) seen.add(ch); });
    });
    return [...seen];
  }

  // 归一化存储值：保留单个字符的字符串项，去重并保持顺序；
  // 接受任意字符（自由文本框），显式空数组表示关闭全部符号（仅修剪空白）。
  function normalizeSplitTrimSymbols(value) {
    if (!Array.isArray(value)) return [...DEFAULT_SPLIT_TRIM_SYMBOLS];
    const seen = new Set();
    const result = [];
    value.forEach((symbol) => {
      if (typeof symbol !== 'string') return;
      const characters = Array.from(symbol);
      if (characters.length !== 1 || seen.has(characters[0])) return;
      seen.add(characters[0]);
      result.push(characters[0]);
    });
    return result;
  }

  function escapeSplitTrimPatternSource(symbol) {
    return String(symbol).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  }

  let activeSplitTrimSymbols = [...DEFAULT_SPLIT_TRIM_SYMBOLS];
  let activeEndTrimPattern = null;
  let activeStartTrimPattern = null;

  function rebuildSplitTrimPatterns() {
    const source = activeSplitTrimSymbols.map(escapeSplitTrimPatternSource).join('|');
    activeEndTrimPattern = new RegExp(`(?:${source}|\\s)+$`, 'u');
    activeStartTrimPattern = new RegExp(`^(?:${source}|\\s)+`, 'u');
  }
  rebuildSplitTrimPatterns();

  // editor 启动时把用户设置同步进来；之后拆分相关的所有修剪路径共用同一份符号表。
  function setSplitTrimSymbols(symbols) {
    activeSplitTrimSymbols = normalizeSplitTrimSymbols(symbols);
    rebuildSplitTrimPatterns();
    return [...activeSplitTrimSymbols];
  }

  function applySplitEdgeTrim(value, edge = 'end') {
    const text = String(value || '');
    if (edge === 'start') return text.replace(activeStartTrimPattern, '');
    return text.replace(activeEndTrimPattern, '');
  }

  // 字幕编辑的时间基准。工程仍以整数毫秒保存兼容字段；帧字段是按工程
  // FPS 计算的平行时间轴，用于需要逐帧定位的编辑操作。
  const TIMELINE_TIMEBASE_UNITS = Object.freeze(['milliseconds', 'frames']);
  const DEFAULT_TIMELINE_FPS = 30;
  const DEFAULT_TIMELINE_TIMECODE_SEPARATOR = ':';
  const MIN_TIMELINE_FPS = 1;
  const MAX_TIMELINE_FPS = 240;

  function normalizeTimelineFps(value, fallback = DEFAULT_TIMELINE_FPS) {
    const fallbackValue = Number.isFinite(Number(fallback))
      ? Number(fallback) : DEFAULT_TIMELINE_FPS;
    const numeric = Number(value);
    const safe = Number.isFinite(numeric) ? numeric : fallbackValue;
    return Math.min(
      MAX_TIMELINE_FPS,
      Math.max(MIN_TIMELINE_FPS, Math.round(safe * 1000) / 1000),
    );
  }

  function normalizeTimelineTimecodeSeparator(value, fallback = DEFAULT_TIMELINE_TIMECODE_SEPARATOR) {
    const fallbackCandidate = Array.from(String(fallback ?? '').trim())[0] || '';
    const safeFallback = fallbackCandidate && !/[\p{Letter}\p{Number}\s]/u.test(fallbackCandidate)
      ? fallbackCandidate : DEFAULT_TIMELINE_TIMECODE_SEPARATOR;
    const candidate = Array.from(String(value ?? '').trim())[0] || '';
    return candidate && !/[\p{Letter}\p{Number}\s]/u.test(candidate) ? candidate : safeFallback;
  }

  function normalizeTimelineTimebase(value, fallback = {}) {
    const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const fallbackRaw = fallback && typeof fallback === 'object' ? fallback : {};
    const fallbackUnit = TIMELINE_TIMEBASE_UNITS.includes(fallbackRaw.unit)
      ? fallbackRaw.unit : 'milliseconds';
    return {
      unit: TIMELINE_TIMEBASE_UNITS.includes(raw.unit) ? raw.unit : fallbackUnit,
      fps: normalizeTimelineFps(raw.fps, fallbackRaw.fps ?? DEFAULT_TIMELINE_FPS),
    };
  }

  function normalizeMediaMetadata(value) {
    if (value == null) return null;
    if (typeof value !== 'object' || Array.isArray(value)) return null;
    const hasVideoWidth = value.video_width !== undefined;
    const hasVideoHeight = value.video_height !== undefined;
    const hasVideoDimensions = hasVideoWidth || hasVideoHeight;
    if (hasVideoWidth !== hasVideoHeight) return null;
    if (hasVideoDimensions
        && (!Number.isInteger(value.video_width) || value.video_width <= 0
          || !Number.isInteger(value.video_height) || value.video_height <= 0)) return null;
    const hasFps = value.video_fps !== undefined;
    const fps = value.video_fps;
    if (hasFps && (typeof fps !== 'number' || !Number.isFinite(fps)
        || fps < MIN_TIMELINE_FPS || fps > MAX_TIMELINE_FPS)) return null;
    if (value.video_fps_ratio !== undefined
        && (!hasFps || typeof value.video_fps_ratio !== 'string' || !value.video_fps_ratio.trim())) return null;
    const hasAudioTracks = value.audio_tracks !== undefined;
    if (hasAudioTracks && !Array.isArray(value.audio_tracks)) return null;
    const hasSelectedAudioTrack = value.selected_audio_track !== undefined;
    if (hasSelectedAudioTrack
        && (!Number.isInteger(value.selected_audio_track) || value.selected_audio_track < 0)) return null;
    if (!hasFps && !hasAudioTracks && !hasSelectedAudioTrack && !hasVideoDimensions) return null;
    const metadata = {};
    if (hasVideoDimensions) {
      metadata.video_width = value.video_width;
      metadata.video_height = value.video_height;
    }
    if (hasFps) metadata.video_fps = normalizeTimelineFps(fps);
    if (typeof value.video_fps_ratio === 'string') {
      metadata.video_fps_ratio = value.video_fps_ratio.trim();
    }
    if (hasAudioTracks) {
      const audioTracks = value.audio_tracks.map((track, index) => {
        if (!track || typeof track !== 'object' || Array.isArray(track)) return null;
        const streamIndex = track.stream_index;
        if (!Number.isInteger(streamIndex) || streamIndex < 0) return null;
        const audioIndex = track.audio_index === undefined ? index : track.audio_index;
        if (!Number.isInteger(audioIndex) || audioIndex < 0) return null;
        const normalized = { audio_index: audioIndex, stream_index: streamIndex };
        for (const field of ['codec', 'language', 'title']) {
          if (track[field] !== undefined && typeof track[field] !== 'string') return null;
          if (typeof track[field] === 'string') normalized[field] = track[field].trim();
        }
        for (const field of ['channels', 'sample_rate']) {
          if (track[field] !== undefined && track[field] !== null
              && (!Number.isInteger(track[field]) || track[field] <= 0)) return null;
          normalized[field] = track[field] ?? null;
        }
        if (track.default !== undefined && typeof track.default !== 'boolean') return null;
        normalized.default = track.default === true;
        return normalized;
      });
      if (audioTracks.some((track) => track === null)) return null;
      metadata.audio_tracks = audioTracks;
    }
    if (hasSelectedAudioTrack) metadata.selected_audio_track = value.selected_audio_track;
    return metadata;
  }

  function frameNumberFromMilliseconds(value, fps = DEFAULT_TIMELINE_FPS) {
    const numeric = Number(value);
    const rate = normalizeTimelineFps(fps);
    return Number.isFinite(numeric) ? Math.max(0, Math.round(numeric * rate / 1000)) : 0;
  }

  function millisecondsFromFrameNumber(value, fps = DEFAULT_TIMELINE_FPS) {
    const frame = Number(value);
    const rate = normalizeTimelineFps(fps);
    return Number.isFinite(frame) ? Math.max(0, Math.round(frame * 1000 / rate)) : 0;
  }

  function nominalTimecodeFps(fps = DEFAULT_TIMELINE_FPS) {
    return Math.max(1, Math.round(normalizeTimelineFps(fps)));
  }

  function formatFrameTimecode(
    value,
    fps = DEFAULT_TIMELINE_FPS,
    separator = DEFAULT_TIMELINE_TIMECODE_SEPARATOR,
  ) {
    const nominalFps = nominalTimecodeFps(fps);
    const totalFrames = Math.max(0, Math.round(Number(value) || 0));
    const frame = totalFrames % nominalFps;
    const totalSeconds = Math.floor(totalFrames / nominalFps);
    const seconds = totalSeconds % 60;
    const minutes = Math.floor(totalSeconds / 60) % 60;
    const hours = Math.floor(totalSeconds / 3600);
    const pad = (number, width) => String(number).padStart(width, '0');
    return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}${
      normalizeTimelineTimecodeSeparator(separator)
    }${pad(frame, 2)}`;
  }

  function formatTimelineTimecode(
    valueMs,
    fps = DEFAULT_TIMELINE_FPS,
    separator = DEFAULT_TIMELINE_TIMECODE_SEPARATOR,
  ) {
    return formatFrameTimecode(frameNumberFromMilliseconds(valueMs, fps), fps, separator);
  }

  function parseFrameTimecode(
    value,
    fps = DEFAULT_TIMELINE_FPS,
    separator = DEFAULT_TIMELINE_TIMECODE_SEPARATOR,
  ) {
    const raw = String(value || '').trim();
    const frameSeparator = normalizeTimelineTimecodeSeparator(separator);
    const escapedSeparator = escapeSplitTrimPatternSource(frameSeparator);
    const match = new RegExp(
      '^(\\d+):(\\d{2}):(\\d{2})\\s*(?:' + escapedSeparator
        + '|;|,|/)\\s*(\\d{1,3})\\s*F?$',
      'iu',
    ).exec(raw);
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);
    const frame = Number(match[4]);
    const nominalFps = nominalTimecodeFps(fps);
    if (minutes >= 60 || seconds >= 60 || frame >= nominalFps) return null;
    return (((hours * 60 + minutes) * 60) + seconds) * nominalFps + frame;
  }

  function clampTimelineFrameStep(value, fallback = 1) {
    return clampInteger(value, fallback, 1, 240);
  }

  const EDITOR_ACCENT_COLOR_VALUES = Object.freeze(['blue', 'red', 'orange', 'custom']);
  const DEFAULT_EDITOR_ACCENT_CUSTOM_COLOR = '#6ca5e8';

  const EDITOR_SUBTITLE_COLOR_NAMES = Object.freeze([
    'yellow', 'green', 'red', 'purple', 'blue',
  ]);
  const DEFAULT_EDITOR_SUBTITLE_COLOR_PALETTE = Object.freeze({
    yellow: '#c4a019',
    green: '#66bb6a',
    red: '#f07f6f',
    purple: '#bf89e6',
    blue: '#61a7fa',
  });

  function normalizeSubtitleColorPalette(value, fallback = DEFAULT_EDITOR_SUBTITLE_COLOR_PALETTE) {
    const source = Array.isArray(value)
      ? Object.fromEntries(value
        .filter((entry) => entry && typeof entry.name === 'string')
        .map((entry) => [entry.name, entry.value]))
      : value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const defaults = fallback && typeof fallback === 'object' && !Array.isArray(fallback)
      ? fallback : DEFAULT_EDITOR_SUBTITLE_COLOR_PALETTE;
    return Object.fromEntries(EDITOR_SUBTITLE_COLOR_NAMES.map((name) => {
      const candidate = String(source[name] ?? '').trim().toLowerCase();
      const defaultValue = String(defaults[name] || DEFAULT_EDITOR_SUBTITLE_COLOR_PALETTE[name]);
      const normalizedDefault = /^#[0-9a-f]{6}$/iu.test(defaultValue)
        ? defaultValue.toLowerCase() : DEFAULT_EDITOR_SUBTITLE_COLOR_PALETTE[name];
      return [name, /^#[0-9a-f]{6}$/iu.test(candidate) ? candidate : normalizedDefault];
    }));
  }

  function normalizeEditorAccentColor(value) {
    return EDITOR_ACCENT_COLOR_VALUES.includes(value) ? value : 'blue';
  }

  function normalizeEditorAccentCustomColor(value) {
    const color = String(value ?? '').trim();
    return /^#[0-9a-f]{6}$/i.test(color)
      ? color.toLowerCase() : DEFAULT_EDITOR_ACCENT_CUSTOM_COLOR;
  }

  const DEFAULT_EDITOR_SETTINGS = Object.freeze({
    splitKey: 'enter', splitUseWordTimestamps: true, splitAutoSubmit: true,
    mainSplitModeOverride: null,
    splitTrimSymbols: [...DEFAULT_SPLIT_TRIM_SYMBOLS],
    overlayEnabled: true, extensionOverlayEnabled: true, assMode: false, multiSubtitleRowHeight: 168,
    subtitleColorPaletteEnabled: false,
    exportStartAtZero: false, cueListShowIndex: true, cueListShowTime: true,
    cueListShowSticker: true, cueListShowCharcount: true, cueListAutoScrollOnClick: true,
    cueListKeepSplitVisible: true, cueListHideDisabled: false, cueListCharcountThreshold: 16,
    cueEditorShowNavigation: false, cueEditorShowTimeActions: false, cueEditorShowSticker: false,
    cueEditorCancelOnEscape: false, selectGroupMembers: false,
    mergeJoinTextContinuous: '', mergeJoinTextWord: ' ',
    autoMergeGapMs: 200, autoMergeSnapDirection: 'backward', autoMergeShortCount: 3,
    autoMergeAbsorbShort: true, autoMergeAbsorbDirection: 'previous', exportColorUnified: true,
    exportSpeakerLabels: false, exportSpeakerNamesAsSuffix: false,
    autoSaveProject: true, autoSaveIntervalSeconds: 30, projectBackupEnabled: true,
    stickerOverlayEnabled: false,
    stickerOtioExportMode: 'original', clickBehavior: 'select-and-seek', clickTarget: 'pointer',
    otioExportIncludeSrt: true, otioExportIncludeStickers: true, otioExportIncludeMarkers: true,
    keyboardOperationReference: 'pointer', jklPlaybackMode: 'direction', mediaSeekStepMs: 1000,
    mediaSeekStepFrames: 1, cueMoveStepMs: 50, cueMoveStepFrames: 1,
    timelineSnapToFrame: true, timelineTimecodeSeparator: DEFAULT_TIMELINE_TIMECODE_SEPARATOR,
    hoverSeekPreview: false, autoSnapAdjacentCues: true, adjacentBoundaryMode: 'dual', ninjaMode: false,
    ninjaSound: true, ninjaSlashEffect: true, ninjaSlashLengthPercent: 80,
    ninjaSlashRotateAmplitude: 6, crossTrackSnap: true, selectBoundSubtitlePair: true,
    multiSubtitleAutoSyncDuration: true, multiSubtitleShowTrackBadges: false, theme: 'dark',
    accentColor: 'blue', accentColorCustom: DEFAULT_EDITOR_ACCENT_CUSTOM_COLOR,
    subtitleColorPalette: { ...DEFAULT_EDITOR_SUBTITLE_COLOR_PALETTE },
    waveShapeSource: 'reapeaks',
  });

  function clampInteger(value, fallback, minimum, maximum) {
    const rounded = Math.round(Number(value));
    return Math.min(maximum, Math.max(minimum, Number.isFinite(rounded) ? rounded : fallback));
  }

  function normalizeEditorSettings(saved = {}) {
    const savedSettings = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
    const legacySeekStepSeconds = Number(savedSettings.mediaSeekStepSeconds);
    const mediaSeekStepMs = savedSettings.mediaSeekStepMs !== undefined
      ? savedSettings.mediaSeekStepMs
      : Number.isFinite(legacySeekStepSeconds) ? legacySeekStepSeconds * 1000 : undefined;
    return {
      ...DEFAULT_EDITOR_SETTINGS,
      splitKey: savedSettings.splitKey === 'ctrl-enter' ? 'ctrl-enter' : 'enter',
      splitUseWordTimestamps: savedSettings.splitUseWordTimestamps !== false,
      splitAutoSubmit: savedSettings.splitAutoSubmit !== false,
      // 主字幕拆分类型手动指定偏好：word / continuous / null（跟随工程与检测）。
      mainSplitModeOverride: ['word', 'continuous'].includes(savedSettings.mainSplitModeOverride)
        ? savedSettings.mainSplitModeOverride : null,
      // undefined → 默认集合；显式空数组表示用户关闭了全部符号（仅修剪空白）。
      splitTrimSymbols: Array.isArray(savedSettings.splitTrimSymbols)
        ? normalizeSplitTrimSymbols(savedSettings.splitTrimSymbols)
        : [...DEFAULT_SPLIT_TRIM_SYMBOLS],
      overlayEnabled: savedSettings.overlayEnabled !== false,
      extensionOverlayEnabled: savedSettings.extensionOverlayEnabled !== false,
      // ASS 字幕模式是预览偏好，默认关闭以保持旧版 CSS 预览行为。
      assMode: savedSettings.assMode === true,
      // 自定义五色开关：关闭时一律使用内置色值（自定义值保留以便再次开启）。
      subtitleColorPaletteEnabled: savedSettings.subtitleColorPaletteEnabled === true,
      multiSubtitleRowHeight: EDITOR_SETTING_ROW_HEIGHTS.includes(Number(savedSettings.multiSubtitleRowHeight))
        ? Number(savedSettings.multiSubtitleRowHeight) : 168,
      exportStartAtZero: savedSettings.exportStartAtZero === true,
      cueListShowIndex: savedSettings.cueListShowIndex !== false,
      cueListShowTime: savedSettings.cueListShowTime !== false,
      cueListShowSticker: savedSettings.cueListShowSticker !== false,
      cueListShowCharcount: savedSettings.cueListShowCharcount !== false,
      cueListAutoScrollOnClick: savedSettings.cueListAutoScrollOnClick !== false,
      cueListKeepSplitVisible: savedSettings.cueListKeepSplitVisible !== false,
      cueListHideDisabled: savedSettings.cueListHideDisabled === true,
      cueListCharcountThreshold: clampInteger(savedSettings.cueListCharcountThreshold, 16, 1, 200),
      cueEditorShowNavigation: savedSettings.cueEditorShowNavigation === true,
      cueEditorShowTimeActions: savedSettings.cueEditorShowTimeActions === true,
      cueEditorShowSticker: savedSettings.cueEditorShowSticker === true,
      cueEditorCancelOnEscape: savedSettings.cueEditorCancelOnEscape === true,
      selectGroupMembers: savedSettings.selectGroupMembers === true,
      // 合并连接符按字幕拆分类型区分：连续型默认直接拼接，单词型默认空格。
      // 旧版只有 mergeJoinText 一个值；用户自定义过则两个类型都沿用旧值。
      mergeJoinTextContinuous: typeof savedSettings.mergeJoinTextContinuous === 'string'
        ? savedSettings.mergeJoinTextContinuous
        : typeof savedSettings.mergeJoinText === 'string' ? savedSettings.mergeJoinText : '',
      mergeJoinTextWord: typeof savedSettings.mergeJoinTextWord === 'string'
        ? savedSettings.mergeJoinTextWord
        : typeof savedSettings.mergeJoinText === 'string' ? savedSettings.mergeJoinText : ' ',
      autoMergeGapMs: clampInteger(savedSettings.autoMergeGapMs, 200, 0, 10000),
      autoMergeSnapDirection: savedSettings.autoMergeSnapDirection === 'forward' ? 'forward' : 'backward',
      autoMergeShortCount: clampInteger(savedSettings.autoMergeShortCount, 3, 1, 20),
      autoMergeAbsorbShort: savedSettings.autoMergeAbsorbShort !== false,
      autoMergeAbsorbDirection: savedSettings.autoMergeAbsorbDirection === 'next' ? 'next' : 'previous',
      exportColorUnified: savedSettings.exportColorUnified !== false,
      exportSpeakerLabels: savedSettings.exportSpeakerLabels === true,
      exportSpeakerNamesAsSuffix: savedSettings.exportSpeakerNamesAsSuffix === true,
      autoSaveProject: savedSettings.autoSaveProject !== false,
      autoSaveIntervalSeconds: clampInteger(savedSettings.autoSaveIntervalSeconds, 30, 5, 3600),
      projectBackupEnabled: savedSettings.projectBackupEnabled !== false,
      projectBackupMinutes: clampInteger(savedSettings.projectBackupMinutes, 5, 1, 1440),
      projectBackupLimit: clampInteger(savedSettings.projectBackupLimit, 20, 1, 1000),
      stickerOverlayEnabled: savedSettings.stickerOverlayEnabled === true,
      stickerOtioExportMode: savedSettings.stickerOtioExportMode === 'portable' ? 'portable' : 'original',
      // 时间线 OTIO 导出选项：默认同时导出 SRT、合并表情包轨、写入字幕标记。
      otioExportIncludeSrt: savedSettings.otioExportIncludeSrt !== false,
      otioExportIncludeStickers: savedSettings.otioExportIncludeStickers !== false,
      otioExportIncludeMarkers: savedSettings.otioExportIncludeMarkers !== false,
      clickBehavior: ['select-only', 'select-and-seek', 'select-and-play'].includes(savedSettings.clickBehavior)
        ? savedSettings.clickBehavior : 'select-and-seek',
      clickTarget: ['cue-start', 'pointer'].includes(savedSettings.clickTarget) ? savedSettings.clickTarget : 'pointer',
      keyboardOperationReference: savedSettings.keyboardOperationReference === 'playhead' ? 'playhead' : 'pointer',
      jklPlaybackMode: ['speed', 'direction'].includes(savedSettings.jklPlaybackMode)
        ? savedSettings.jklPlaybackMode : 'direction',
      mediaSeekStepMs: clampInteger(mediaSeekStepMs, 1000, 10, 60000),
      mediaSeekStepFrames: clampTimelineFrameStep(savedSettings.mediaSeekStepFrames, 1),
      cueMoveStepMs: clampInteger(savedSettings.cueMoveStepMs, 50, 10, 2000),
      cueMoveStepFrames: clampTimelineFrameStep(savedSettings.cueMoveStepFrames, 1),
      timelineSnapToFrame: savedSettings.timelineSnapToFrame !== false,
      timelineTimecodeSeparator: normalizeTimelineTimecodeSeparator(savedSettings.timelineTimecodeSeparator),
      hoverSeekPreview: savedSettings.hoverSeekPreview === true,
      autoSnapAdjacentCues: savedSettings.autoSnapAdjacentCues !== false,
      // 相接字幕边界拖动方式：dual（中缝联动，达芬奇式，默认）/ classic（自动吸附开关 + Alt 反转）。
      adjacentBoundaryMode: savedSettings.adjacentBoundaryMode === 'classic' ? 'classic' : 'dual',
      ninjaMode: savedSettings.ninjaMode === true,
      ninjaSound: savedSettings.ninjaSound !== false,
      ninjaSlashEffect: savedSettings.ninjaSlashEffect !== false,
      ninjaSlashLengthPercent: clampInteger(savedSettings.ninjaSlashLengthPercent, 80, 20, 400),
      ninjaSlashRotateAmplitude: clampInteger(savedSettings.ninjaSlashRotateAmplitude, 6, 0, 60),
      crossTrackSnap: savedSettings.crossTrackSnap !== false,
      selectBoundSubtitlePair: savedSettings.selectBoundSubtitlePair !== false,
      multiSubtitleAutoSyncDuration: savedSettings.multiSubtitleAutoSyncDuration !== false,
      multiSubtitleShowTrackBadges: savedSettings.multiSubtitleShowTrackBadges === true,
      theme: ['light', 'dark', 'system'].includes(savedSettings.theme)
        ? savedSettings.theme : 'dark',
      accentColor: normalizeEditorAccentColor(savedSettings.accentColor),
      accentColorCustom: normalizeEditorAccentCustomColor(savedSettings.accentColorCustom),
      subtitleColorPalette: normalizeSubtitleColorPalette(savedSettings.subtitleColorPalette),
      waveShapeSource: savedSettings.waveShapeSource === 'self' ? 'self' : 'reapeaks',
    };
  }

  function normalizeMultiSubtitleRowHeight(value) {
    return EDITOR_SETTING_ROW_HEIGHTS.includes(Number(value)) ? Number(value) : 168;
  }
  function normalizeClickBehavior(value) {
    return ['select-only', 'select-and-seek', 'select-and-play'].includes(value)
      ? value : 'select-and-seek';
  }
  function normalizeClickTarget(value) {
    return ['cue-start', 'pointer'].includes(value) ? value : 'pointer';
  }
  function normalizeKeyboardOperationReferenceMode(value) {
    return value === 'playhead' ? 'playhead' : 'pointer';
  }
  function normalizeJklPlaybackMode(value) {
    return ['speed', 'direction'].includes(value) ? value : 'direction';
  }
  function clampMediaSeekStepMs(value) { return clampInteger(value, 1000, 10, 60000); }
  function clampCueMoveStepMs(value) { return clampInteger(value, 50, 10, 2000); }
  function clampAutoSaveInterval(value) { return clampInteger(value, 30, 5, 3600); }
  function clampCharcountThreshold(value) { return clampInteger(value, 16, 1, 200); }
  function clampNinjaSlashLength(value) { return clampInteger(value, 80, 20, 400); }
  function clampNinjaSlashRotateAmplitude(value) { return clampInteger(value, 6, 0, 60); }
  function clampAutoMergeGapMs(value) { return clampInteger(value, 200, 0, 10000); }
  function clampAutoMergeShortCount(value) { return clampInteger(value, 3, 1, 20); }

  const GAP_REMOVE_CORE = window.AsrGapRemoveCore;
  if (!GAP_REMOVE_CORE) throw new Error('AsrGapRemoveCore must load before AsrEditorUtils');
  const GAP_REMOVE_SCHEMA = GAP_REMOVE_CORE.GAP_REMOVE_SCHEMA;
  const GAP_REMOVE_DISABLE_COVERAGE_DEFAULT = GAP_REMOVE_CORE.GAP_REMOVE_DISABLE_COVERAGE_DEFAULT;
  const GAP_REMOVE_DISABLE_REMAINING_DEFAULT_MS = GAP_REMOVE_CORE.GAP_REMOVE_DISABLE_REMAINING_DEFAULT_MS;
  const GAP_REMOVE_DISABLE_REMAINING_MAX_MS = GAP_REMOVE_CORE.GAP_REMOVE_DISABLE_REMAINING_MAX_MS;
  const clampGapRemoveDisableCoverage = GAP_REMOVE_CORE.clampGapRemoveDisableCoverage;
  const clampGapRemoveDisableRemaining = GAP_REMOVE_CORE.clampGapRemoveDisableRemaining;
  const normalizeGapRemoveData = GAP_REMOVE_CORE.normalizeGapRemoveData;
  const normalizeGapRemoveGaps = GAP_REMOVE_CORE.normalizeGapRemoveGaps;
  const normalizeGapRemoveProvenance = GAP_REMOVE_CORE.normalizeGapRemoveProvenance;
  const gapRangesFromProvenance = GAP_REMOVE_CORE.gapRangesFromProvenance;
  const decorateGapRemoveGaps = GAP_REMOVE_CORE.decorateGapRemoveGaps;
  const getGapRemoveDisplayType = GAP_REMOVE_CORE.getGapRemoveDisplayType;
  const isGapRemoveDisplayProtected = GAP_REMOVE_CORE.isGapRemoveDisplayProtected;
  const removeGapRemoveProvenanceRange = GAP_REMOVE_CORE.removeGapRemoveProvenanceRange;
  const getGapRemoveDisplayGaps = GAP_REMOVE_CORE.getGapRemoveDisplayGaps;
  const replaceGapRemoveProvenanceSource = GAP_REMOVE_CORE.replaceGapRemoveProvenanceSource;
  const appendGapRemoveManualOverrides = GAP_REMOVE_CORE.appendGapRemoveManualOverrides;
  const applyGapRemoveRange = GAP_REMOVE_CORE.applyGapRemoveRange;
  const shrinkGapRemoveGaps = GAP_REMOVE_CORE.shrinkGapRemoveGaps;
  const moveGapRemoveRange = GAP_REMOVE_CORE.moveGapRemoveRange;
  const copyGapRemoveRange = GAP_REMOVE_CORE.copyGapRemoveRange;
  const moveGapRemoveProvenance = GAP_REMOVE_CORE.moveGapRemoveProvenance;
  const resizeGapRemoveBoundary = GAP_REMOVE_CORE.resizeGapRemoveBoundary;
  const detectAudioGapRemoveGaps = GAP_REMOVE_CORE.detectAudioGapRemoveGaps;
  const getRemovedGapRanges = GAP_REMOVE_CORE.getRemovedGapRanges;
  const findGapRemoveDisableMatches = GAP_REMOVE_CORE.findGapRemoveDisableMatches;
  const mapGapRemovedTime = GAP_REMOVE_CORE.mapGapRemovedTime;
  const buildGapRemovedIntervals = GAP_REMOVE_CORE.buildGapRemovedIntervals;

  // Dynamic-caption exporters need the same compressed timeline as SRT/OTIO,
  // while preserving the source segment objects for the editor. Items that are
  // wholly inside a removed gap remain as zero-width mapped ranges so their
  // text-to-item correspondence is not lost; the builders already ignore
  // zero-duration highlight ranges when appropriate.
  function buildGapRemovedDynamicSegments(segments, gaps) {
    const source = Array.isArray(segments) ? segments : [];
    return source.flatMap((segment) => {
      if (!segment || typeof segment !== 'object') return [];
      const start = Number(segment.start);
      const end = Number(segment.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
      const mappedStart = mapGapRemovedTime(start, gaps);
      const mappedEnd = mapGapRemovedTime(end, gaps);
      if (mappedEnd <= mappedStart) return [];
      const mapped = { ...segment, start: mappedStart, end: mappedEnd };
      if (Array.isArray(segment.items)) {
        mapped.items = segment.items.map((item) => {
          if (!item || typeof item !== 'object') return item;
          const itemStart = Number(item.start);
          const itemEnd = Number(item.end);
          if (!Number.isFinite(itemStart) || !Number.isFinite(itemEnd)) return { ...item };
          return {
            ...item,
            start: mapGapRemovedTime(itemStart, gaps),
            end: mapGapRemovedTime(itemEnd, gaps),
          };
        });
      }
      return [mapped];
    });
  }

  // 「填充区间空隙」：以一个时间点为锚点，取左右两侧最近的「已激活」空隙作为
  // 边界，返回需要完全填充为单一空隙的区间。未激活空隙不作为边界，落在区间
  // 内时会被直接吞掉；锚点落在已激活空隙内时返回该空隙本身；锚点位于所有
  // 已激活空隙之前/之后时，边界向时间轴开头/结尾（durationMs）拓展。
  function resolveGapFillRange(gaps, pointMs, durationMs = 0) {
    const normalized = normalizeGapRemoveGaps(gaps).filter((gap) => gap.removed !== false);
    if (!normalized.length) return null;
    const point = Number(pointMs);
    if (!Number.isFinite(point)) return null;
    const containing = normalized.find((gap) => gap.start <= point && gap.end >= point);
    if (containing) return { start: containing.start, end: containing.end };
    const previous = [...normalized].reverse().find((gap) => gap.end <= point) || null;
    const next = normalized.find((gap) => gap.start >= point) || null;
    const duration = Math.max(0, Math.round(Number(durationMs) || 0));
    if (!next && duration <= 0) return null;
    const start = previous ? previous.start : 0;
    const end = next ? next.end : duration;
    if (end <= start) return null;
    return { start, end };
  }

  const HISTORY_RECORD_DEFAULT_LABELS = Object.freeze({
    segments: '编辑', layout: '调整工作区', gap_remove: '空隙移除', preview: '预览',
  });
  function buildSegmentsHistorySnapshot(segments, multiSubtitle, overlayTrack = null) {
    return {
      segments: cloneJsonValue(segments),
      multi_subtitle: cloneJsonValue(multiSubtitle),
      overlay_track: cloneJsonValue(overlayTrack),
    };
  }
  function buildHistoryRecord(kind, label, payload, view = null) {
    const recordKind = Object.prototype.hasOwnProperty.call(HISTORY_RECORD_DEFAULT_LABELS, kind)
      ? kind : 'segments';
    const record = { kind: recordKind, label: label || HISTORY_RECORD_DEFAULT_LABELS[recordKind] };
    if (recordKind === 'segments') {
      record.segs = cloneJsonValue(payload);
      if (view) record.view = cloneJsonValue(view);
    } else if (recordKind === 'layout') record.layout = payload || null;
    else if (recordKind === 'gap_remove') {
      record.gapRemove = cloneJsonValue(payload?.gapRemove ?? null);
      record.gapRemoveDirty = payload?.gapRemoveDirty === true;
    } else record.preview = cloneJsonValue(payload);
    return record;
  }

  // === 多重字幕（双语字幕）===
  // 这组 helper 刻意不依赖 DOM，便携 HTML、localhost 编辑器和 Node 测试共用同一套
  // 数据/匹配/近似拆分规则。主轨仍然是顶层 segments；副轨的 items 不参与拆分。
  const MULTI_SUBTITLE_SCHEMA = 'moy.asr.multi_subtitle.v1';
  const MULTI_SUBTITLE_TOLERANCE_MS = 300;
  const MULTI_SUBTITLE_DISPLAY_MODES = new Set(['main', 'extension', 'both']);
  const MULTI_SUBTITLE_SPLIT_MODES = new Set(['continuous', 'word']);

  function stableId(value) {
    const id = String(value == null ? '' : value).trim();
    return id && id.length <= 160 ? id : '';
  }

  function ensureStableSegmentIds(segments, prefix = 'segment') {
    const source = Array.isArray(segments) ? segments : [];
    // Reserve every valid explicit ID first. This keeps the browser's repair
    // result identical to maw.project._normalize_stable_ids when a generated
    // ID would otherwise collide with a later explicit one.
    const reserved = new Set(source
      .map((segment) => stableId(segment?.id))
      .filter(Boolean));
    const used = new Set();
    let changed = 0;
    source.forEach((segment, index) => {
      if (!segment || typeof segment !== 'object') return;
      let id = stableId(segment.id);
      if (!id || used.has(id)) {
        const base = `${prefix}-${String(index + 1).padStart(3, '0')}`;
        id = base;
        let suffix = 2;
        while (used.has(id) || (id !== base && reserved.has(id))) {
          id = `${base}-${suffix++}`;
        }
        if (reserved.has(id)) {
          id = `${base}-generated`;
          suffix = 2;
          while (used.has(id) || reserved.has(id)) {
            id = `${base}-generated-${suffix++}`;
          }
        }
        segment.id = id;
        changed++;
      } else if (segment.id !== id) {
        segment.id = id;
        changed++;
      }
      used.add(id);
    });
    return changed;
  }

  function uniqueStableSegmentId(segments, baseId, fallbackPrefix = 'segment') {
    const used = new Set((Array.isArray(segments) ? segments : [])
      .map((segment) => stableId(segment?.id)).filter(Boolean));
    const base = stableId(baseId) || `${fallbackPrefix}-new`;
    if (!used.has(base)) return base;
    let suffix = 2;
    let candidate = `${base}-${suffix}`;
    while (used.has(candidate)) candidate = `${base}-${suffix++}`;
    return candidate;
  }

  function normalizeOverlayTrack(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const rawSegments = Array.isArray(source.segments) ? source.segments : [];
    const segments = rawSegments
      .filter((segment) => segment && typeof segment === 'object')
      .map((segment) => {
        const copy = { ...segment };
        if (Array.isArray(copy.items)) copy.items = copy.items.map((item) => ({ ...item }));
        else delete copy.items;
        return copy;
      });
    ensureStableSegmentIds(segments, 'overlay');
    return { enabled: source.enabled === true, segments };
  }

  function mergeMainAndOverlaySegments(mainSegments, overlaySegments) {
    const main = Array.isArray(mainSegments) ? mainSegments : [];
    const overlay = Array.isArray(overlaySegments) ? overlaySegments : [];
    return [
      ...main.map((segment, index) => ({ segment, trackOrder: 0, index })),
      ...overlay.map((segment, index) => ({ segment, trackOrder: 1, index })),
    ].sort((left, right) => (
      Number(left.segment?.start) - Number(right.segment?.start)
      || left.trackOrder - right.trackOrder
      || left.index - right.index
    )).map(({ segment }) => segment);
  }

  // === 叠加字幕轨的段落迁移 ===
  // 主轨与叠加轨是两条互不绑定的时间轴；把段落从一条轨移到另一条轨时保持
  // 目标轨按 start 升序（同 start 时插到既有段之后），返回段在新轨中的下标。
  // 原地修改传入数组——编辑器以 DATA.segments / DATA.overlay_track 为真源。
  function insertSegmentByStart(trackSegments, segment) {
    const list = Array.isArray(trackSegments) ? trackSegments : [];
    const start = Number(segment?.start);
    let insertAt = list.length;
    for (let index = 0; index < list.length; index += 1) {
      if (Number(list[index]?.start) > start) {
        insertAt = index;
        break;
      }
    }
    list.splice(insertAt, 0, segment);
    return insertAt;
  }

  function moveSegmentBetweenTracks(sourceSegments, targetSegments, index) {
    const source = Array.isArray(sourceSegments) ? sourceSegments : [];
    const target = Array.isArray(targetSegments) ? targetSegments : [];
    if (!Number.isInteger(index) || index < 0 || index >= source.length) return -1;
    const segment = source[index];
    if (!segment || typeof segment !== 'object') return -1;
    source.splice(index, 1);
    return insertSegmentByStart(target, segment);
  }

  function normalizeMultiSubtitle(value, mainSegments = []) {
    const source = value && typeof value === 'object' ? value : {};
    const rawTracks = Array.isArray(source.tracks) ? source.tracks : [];
    const tracks = rawTracks.map((rawTrack, trackIndex) => {
      const track = rawTrack && typeof rawTrack === 'object' ? rawTrack : {};
      const id = stableId(track.id) || `extension-${trackIndex + 1}`;
      const rawSegments = Array.isArray(track.segments) ? track.segments : [];
      const segments = rawSegments
        .filter((segment) => segment && typeof segment === 'object')
        .map((segment) => {
          const copy = { ...segment };
          // Extension SRT has no items, while an imported mosp/project or a
          // swapped-down main track may carry optional word timestamps. Keep
          // them when present so a later swap can restore the main track.
          if (Array.isArray(copy.items)) {
            copy.items = copy.items.map((item) => ({ ...item }));
          } else {
            delete copy.items;
          }
          return copy;
        });
      ensureStableSegmentIds(segments, `${id}-segment`);
      return {
        id,
        role: 'extension',
        name: typeof track.name === 'string' && track.name.trim() ? track.name : '副字幕',
        language: typeof track.language === 'string' ? track.language : '',
        source_name: typeof track.source_name === 'string' ? track.source_name : '',
        split_mode: MULTI_SUBTITLE_SPLIT_MODES.has(track.split_mode)
          ? track.split_mode : detectSubtitleSplitMode(segments.map((s) => s.text).join('\n'), track.language),
        segments,
      };
    });
    const mainIds = new Set((Array.isArray(mainSegments) ? mainSegments : [])
      .map((segment) => stableId(segment?.id)).filter(Boolean));
    const extensionIds = new Map(tracks.map((track) => [track.id, new Set(track.segments.map((s) => s.id))]));
    const bindings = Array.isArray(source.bindings) ? source.bindings : [];
    const normalizedBindings = bindings.map((rawBinding, index) => {
      const binding = rawBinding && typeof rawBinding === 'object' ? rawBinding : {};
      const trackId = stableId(binding.track_id) || tracks[0]?.id || 'extension-1';
      const trackIds = extensionIds.get(trackId) || new Set();
      const mainSegmentIds = (Array.isArray(binding.main_segment_ids)
        ? binding.main_segment_ids : binding.main_segment_id ? [binding.main_segment_id] : [])
        .map(stableId).filter((id) => mainIds.has(id));
      const extensionSegmentIds = (Array.isArray(binding.extension_segment_ids)
        ? binding.extension_segment_ids : binding.extension_segment_id ? [binding.extension_segment_id] : [])
        .map(stableId).filter((id) => trackIds.has(id));
      if (!mainSegmentIds.length || !extensionSegmentIds.length) return null;
      return {
        id: stableId(binding.id) || `binding-${String(index + 1).padStart(3, '0')}`,
        track_id: trackId,
        main_segment_ids: [...new Set(mainSegmentIds)],
        extension_segment_ids: [...new Set(extensionSegmentIds)],
        start_offset_ms: Number.isFinite(Number(binding.start_offset_ms))
          ? Math.round(Number(binding.start_offset_ms)) : 0,
        end_offset_ms: Number.isFinite(Number(binding.end_offset_ms))
          ? Math.round(Number(binding.end_offset_ms)) : 0,
      };
    }).filter(Boolean);
    const dedupedBindings = [];
    const seenMain = new Set();
    const seenExtension = new Set();
    normalizedBindings.forEach((binding) => {
      // MVP editing is one-to-one. Keep the first valid relation when a malformed
      // imported project contains duplicate endpoints, while retaining arrays for
      // a future one-to-many binding model.
      const mainKey = binding.main_segment_ids.join('|');
      const extensionKey = `${binding.track_id}:${binding.extension_segment_ids.join('|')}`;
      if (seenMain.has(mainKey) || seenExtension.has(extensionKey)) return;
      seenMain.add(mainKey);
      seenExtension.add(extensionKey);
      dedupedBindings.push(binding);
    });
    const normalized = {
      schema: MULTI_SUBTITLE_SCHEMA,
      enabled: source.enabled === true,
      display_mode: MULTI_SUBTITLE_DISPLAY_MODES.has(source.display_mode)
        ? source.display_mode : 'both',
      main_split_mode: MULTI_SUBTITLE_SPLIT_MODES.has(source.main_split_mode)
        ? source.main_split_mode
        : detectSubtitleSplitMode((Array.isArray(mainSegments) ? mainSegments : [])
          .map((segment) => segment?.text || '').join('\n')),
      tracks,
      bindings: dedupedBindings,
    };
    rebuildBindingOffsets(normalized, mainSegments);
    return normalized;
  }

  function normalizeMultiSubtitleProject(project) {
    if (!project || typeof project !== 'object') return project;
    ensureStableSegmentIds(project.segments, 'main');
    project.overlay_track = normalizeOverlayTrack(project.overlay_track);
    project.multi_subtitle = normalizeMultiSubtitle(project.multi_subtitle, project.segments);
    return project;
  }

  function detectSubtitleSplitMode(text, language = '') {
    const value = `${String(language || '')} ${String(text || '')}`;
    return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u.test(value)
      ? 'continuous' : 'word';
  }

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

  function cleanSplitTextParts(text, offset, preserveWordConnector = false) {
    const value = String(text || '');
    const safeOffset = Math.max(0, Math.min(value.length, Math.round(Number(offset) || 0)));
    const trimPattern = preserveWordConnector ? /\s+$/u : activeEndTrimPattern;
    const trimStartPattern = preserveWordConnector ? /^\s+/u : activeStartTrimPattern;
    const left = value.slice(0, safeOffset).replace(trimPattern, '');
    const right = value.slice(safeOffset).replace(trimStartPattern, '');
    return { left, right, offset: safeOffset };
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

  function bindingForSegment(multiSubtitle, segmentId, side = 'either', trackId = null) {
    const id = stableId(segmentId);
    if (!id || !multiSubtitle) return null;
    return (Array.isArray(multiSubtitle.bindings) ? multiSubtitle.bindings : []).find((binding) => {
      if (trackId && binding.track_id !== trackId) return false;
      const inMain = binding.main_segment_ids?.includes(id);
      const inExtension = binding.extension_segment_ids?.includes(id);
      return side === 'main' ? inMain : side === 'extension' ? inExtension : inMain || inExtension;
    }) || null;
  }

  function buildSubtitleBinding(mainSegment, extensionSegment, trackId, id = null) {
    const main = mainSegment || {};
    const extension = extensionSegment || {};
    return {
      id: stableId(id) || `binding-${stableId(main.id) || 'main'}-${stableId(extension.id) || 'extension'}`,
      track_id: stableId(trackId) || 'extension-1',
      main_segment_ids: stableId(main.id) ? [main.id] : [],
      extension_segment_ids: stableId(extension.id) ? [extension.id] : [],
      start_offset_ms: Math.round(Number(extension.start) - Number(main.start)) || 0,
      end_offset_ms: Math.round(Number(extension.end) - Number(main.end)) || 0,
    };
  }

  function rebuildBindingOffsets(multiSubtitle, mainSegments) {
    if (!multiSubtitle) return multiSubtitle;
    const mainById = new Map((Array.isArray(mainSegments) ? mainSegments : [])
      .map((segment) => [stableId(segment?.id), segment]));
    const trackById = new Map((multiSubtitle.tracks || []).map((track) => [track.id, track]));
    (multiSubtitle.bindings || []).forEach((binding) => {
      const main = mainById.get(binding.main_segment_ids?.[0]);
      const track = trackById.get(binding.track_id);
      const extension = track?.segments?.find((segment) => segment.id === binding.extension_segment_ids?.[0]);
      if (!main || !extension) return;
      binding.start_offset_ms = Math.round(Number(extension.start) - Number(main.start));
      binding.end_offset_ms = Math.round(Number(extension.end) - Number(main.end));
    });
    return multiSubtitle;
  }

  function copySubtitleColorFields(source, target) {
    if (!source || !target) return;
    if (source.color != null) target.color = cloneJsonValue(source.color);
    if (source.color_ref != null) target.color_ref = cloneJsonValue(source.color_ref);
  }

  // 把 sourceSegments 中按绑定关系找到的颜色组写入 targetSegments。
  // target 的 headIdx 不能直接复用 source 下标：交换后两条字幕的数组长度和顺序
  // 可能不同，因此每个目标颜色组都在目标数组中重新选择最早的一条作为 head。
  function mapBoundSubtitleColors(sourceSegments, targetSegments, sourceToTarget) {
    if (!Array.isArray(sourceSegments) || !Array.isArray(targetSegments)
        || !(sourceToTarget instanceof Map)) return 0;
    const groups = new Map();
    sourceSegments.forEach((segment, sourceIndex) => {
      const sourceHeadIndex = segment?.color
        ? sourceIndex
        : Number.isInteger(segment?.color_ref?.headIdx) ? segment.color_ref.headIdx : null;
      const sourceHead = Number.isInteger(sourceHeadIndex)
        ? sourceSegments[sourceHeadIndex]?.color
        : null;
      const targetIndex = sourceToTarget.get(sourceIndex);
      if (!sourceHead || typeof sourceHead !== 'object'
          || !Number.isInteger(targetIndex) || !targetSegments[targetIndex]) return;
      const group = groups.get(sourceHeadIndex) || {
        sourceHead,
        targetIndexes: [],
      };
      group.targetIndexes.push(targetIndex);
      groups.set(sourceHeadIndex, group);
    });

    let mappedCount = 0;
    groups.forEach(({ sourceHead, targetIndexes }) => {
      const uniqueTargetIndexes = [...new Set(targetIndexes)].sort((left, right) => left - right);
      if (!uniqueTargetIndexes.length) return;
      const targetHeadIndex = uniqueTargetIndexes[0];
      const targetLastIndex = uniqueTargetIndexes[uniqueTargetIndexes.length - 1];
      const mappedHead = cloneJsonValue(sourceHead) || {};
      if (Number.isFinite(Number(targetSegments[targetHeadIndex]?.start))) {
        mappedHead.start = targetSegments[targetHeadIndex].start;
      }
      if (Number.isFinite(Number(targetSegments[targetLastIndex]?.end))) {
        mappedHead.end = targetSegments[targetLastIndex].end;
      }
      uniqueTargetIndexes.forEach((targetIndex, memberIndex) => {
        const target = targetSegments[targetIndex];
        target.color = null;
        target.color_ref = null;
        if (memberIndex === 0) {
          target.color = mappedHead;
        } else {
          target.color_ref = { name: mappedHead.name, headIdx: targetHeadIndex };
        }
        mappedCount++;
      });
    });
    return mappedCount;
  }

  // 交换主轨与当前唯一副轨。副轨保留可选的 items 和颜色信息，
  // 绑定关系按端点整体交换，并在新主轨写入后重新计算 offset。
  function swapMainAndExtensionSubtitle(project, trackId = null) {
    if (!project || typeof project !== 'object' || !Array.isArray(project.segments)) {
      return { swapped: false, reason: 'invalid-project' };
    }
    ensureStableSegmentIds(project.segments, 'main');
    const multi = normalizeMultiSubtitle(project.multi_subtitle, project.segments);
    project.multi_subtitle = multi;
    const tracks = Array.isArray(multi.tracks) ? multi.tracks : [];
    if (tracks.length !== 1) return { swapped: false, reason: 'unsupported-track-count' };
    const track = tracks.find((candidate) => !trackId || candidate.id === trackId);
    if (!track || !Array.isArray(track.segments)) return { swapped: false, reason: 'missing-track' };
    if (!project.segments.length || !track.segments.length) return { swapped: false, reason: 'empty-track' };

    const oldMain = cloneJsonValue(project.segments) || [];
    const oldExtension = cloneJsonValue(track.segments) || [];
    const oldMainSplitMode = multi.main_split_mode;
    const oldExtensionSplitMode = track.split_mode;
    const nextMain = oldExtension.map((segment) => ({ ...segment }));
    const oldMainIndexById = new Map(oldMain.map((segment, index) => [stableId(segment?.id), index]));
    const oldExtensionIndexById = new Map(
      oldExtension.map((segment, index) => [stableId(segment?.id), index]),
    );
    const mainToExtensionIndex = new Map();
    (multi.bindings || []).forEach((binding) => {
      if (binding.track_id !== track.id) return;
      const sourceIds = Array.isArray(binding.main_segment_ids)
        ? binding.main_segment_ids : [];
      const targetIds = Array.isArray(binding.extension_segment_ids)
        ? binding.extension_segment_ids : [];
      const pairCount = Math.min(sourceIds.length, targetIds.length);
      for (let pairIndex = 0; pairIndex < pairCount; pairIndex++) {
        const sourceIndex = oldMainIndexById.get(stableId(sourceIds[pairIndex]));
        const targetIndex = oldExtensionIndexById.get(stableId(targetIds[pairIndex]));
        if (Number.isInteger(sourceIndex) && Number.isInteger(targetIndex)
            && !mainToExtensionIndex.has(sourceIndex)) {
          mainToExtensionIndex.set(sourceIndex, targetIndex);
        }
      }
    });
    const mappedColorCount = mapBoundSubtitleColors(
      oldMain,
      nextMain,
      mainToExtensionIndex,
    );
    const nextExtension = oldMain.map((segment) => {
      const copy = {
        id: stableId(segment.id),
        start: segment.start,
        end: segment.end,
        text: typeof segment.text === 'string' ? segment.text : '',
      };
      if (Array.isArray(segment.items)) {
        copy.items = segment.items.map((item) => ({ ...item }));
      }
      copySubtitleColorFields(segment, copy);
      if (segment._dirty) copy._dirty = true;
      return copy;
    });

    project.segments.length = 0;
    nextMain.forEach((segment) => project.segments.push(segment));
    track.segments = nextExtension;
    multi.main_split_mode = oldExtensionSplitMode;
    track.split_mode = oldMainSplitMode;

    let bindingCount = 0;
    (multi.bindings || []).forEach((binding) => {
      if (binding.track_id !== track.id) return;
      const mainIds = binding.main_segment_ids;
      binding.main_segment_ids = [...(binding.extension_segment_ids || [])];
      binding.extension_segment_ids = [...(mainIds || [])];
      bindingCount++;
    });
    rebuildBindingOffsets(multi, project.segments);
    return {
      swapped: true,
      trackId: track.id,
      mainCount: project.segments.length,
      extensionCount: track.segments.length,
      bindingCount,
      mappedColorCount,
    };
  }

  function removeSubtitleBindings(multiSubtitle, predicate) {
    if (!multiSubtitle || !Array.isArray(multiSubtitle.bindings)) return [];
    const removed = [];
    multiSubtitle.bindings = multiSubtitle.bindings.filter((binding) => {
      if (!predicate(binding)) return true;
      removed.push(binding);
      return false;
    });
    return removed;
  }

  function matchSubtitleSegments(mainSegments, extensionSegments, toleranceMs = MULTI_SUBTITLE_TOLERANCE_MS) {
    const main = Array.isArray(mainSegments) ? mainSegments : [];
    const extension = Array.isArray(extensionSegments) ? extensionSegments : [];
    const tolerance = Math.max(0, Math.round(Number(toleranceMs) || MULTI_SUBTITLE_TOLERANCE_MS));
    const candidates = [];
    const byExtension = extension.map(() => []);
    const byMain = main.map(() => []);
    extension.forEach((candidateExtension, extensionIndex) => {
      main.forEach((candidateMain, mainIndex) => {
        const startDiff = Math.abs(Number(candidateExtension?.start) - Number(candidateMain?.start));
        const endDiff = Math.abs(Number(candidateExtension?.end) - Number(candidateMain?.end));
        const overlaps = Number(candidateExtension?.start) <= Number(candidateMain?.end)
          && Number(candidateExtension?.end) >= Number(candidateMain?.start);
        if (!overlaps || startDiff > tolerance || endDiff > tolerance) return;
        const candidate = { mainIndex, extensionIndex, startDiff, endDiff, cost: startDiff + endDiff };
        candidates.push(candidate);
        byExtension[extensionIndex].push(candidate);
        byMain[mainIndex].push(candidate);
      });
    });
    candidates.sort((left, right) => left.cost - right.cost || left.startDiff - right.startDiff
      || left.extensionIndex - right.extensionIndex || left.mainIndex - right.mainIndex);
    const usedMain = new Set();
    const usedExtension = new Set();
    const matches = [];
    candidates.forEach((candidate) => {
      if (usedMain.has(candidate.mainIndex) || usedExtension.has(candidate.extensionIndex)) return;
      usedMain.add(candidate.mainIndex);
      usedExtension.add(candidate.extensionIndex);
      matches.push(candidate);
    });
    const conflictExtensions = byExtension.filter((items) => items.length > 1).length;
    const conflictMains = byMain.filter((items) => items.length > 1).length;
    return {
      matches,
      unmatchedMain: main.map((_, index) => index).filter((index) => !usedMain.has(index)),
      unmatchedExtension: extension.map((_, index) => index).filter((index) => !usedExtension.has(index)),
      candidates,
      conflicts: Math.max(conflictExtensions, conflictMains),
      tolerance_ms: tolerance,
    };
  }

  function buildMultiDisplayRows(mainSegments, extensionSegments, bindings = []) {
    const main = Array.isArray(mainSegments) ? mainSegments : [];
    const extension = Array.isArray(extensionSegments) ? extensionSegments : [];
    const extensionById = new Map(extension.map((segment, index) => [stableId(segment?.id), index]));
    const mainToExtension = new Map();
    const extensionBound = new Set();
    bindings.forEach((binding) => {
      const mainId = binding.main_segment_ids?.[0];
      const extensionId = binding.extension_segment_ids?.[0];
      const extensionIndex = extensionById.get(extensionId);
      if (!Number.isInteger(extensionIndex) || mainToExtension.has(mainId)) return;
      mainToExtension.set(mainId, extensionIndex);
      extensionBound.add(extensionIndex);
    });
    const rows = [];
    let extensionCursor = 0;
    main.forEach((segment, mainIndex) => {
      while (extensionCursor < extension.length && !extensionBound.has(extensionCursor)
          && Number(extension[extensionCursor]?.start) <= Number(segment?.start)) {
        rows.push({ mainIndex: null, extensionIndex: extensionCursor++ });
      }
      rows.push({ mainIndex, extensionIndex: mainToExtension.get(segment.id) ?? null });
    });
    while (extensionCursor < extension.length) {
      if (!extensionBound.has(extensionCursor)) rows.push({ mainIndex: null, extensionIndex: extensionCursor });
      extensionCursor++;
    }
    return rows;
  }

  // 合并选区只有在每条字幕都指向同一个有效 group head 时才继承该 group。
  // 若选区包含 head，新字幕继续作为 head；若选区只是同组 refs，则继续指向原 head。
  function resolveMergedGroupInheritance(segments, indexes, headField, refField) {
    if (!Array.isArray(segments) || !Array.isArray(indexes) || !indexes.length) {
      return { head: null, ref: null, headIdx: null };
    }
    const headIndexes = indexes.map((index) => {
      const segment = segments[index];
      if (!segment) return null;
      if (segment[headField]) return index;
      const headIdx = segment[refField]?.headIdx;
      return Number.isInteger(headIdx) && segments[headIdx]?.[headField] ? headIdx : null;
    });
    const commonHeadIdx = headIndexes[0];
    if (
      !Number.isInteger(commonHeadIdx)
      || headIndexes.some((headIdx) => headIdx !== commonHeadIdx)
    ) {
      return { head: null, ref: null, headIdx: null };
    }

    const head = segments[commonHeadIdx][headField];
    if (indexes.includes(commonHeadIdx)) {
      return {
        head: cloneJsonValue(head),
        ref: null,
        headIdx: commonHeadIdx,
      };
    }

    const sourceRef = indexes
      .map((index) => segments[index]?.[refField])
      .find((ref) => ref && ref.headIdx === commonHeadIdx);
    const inheritedRef = cloneJsonValue(sourceRef) || {};
    inheritedRef.headIdx = commonHeadIdx;
    if (!inheritedRef.name && head?.name) inheritedRef.name = head.name;
    return {
      head: null,
      ref: inheritedRef,
      headIdx: commonHeadIdx,
    };
  }

  function getSrtExportFirstIndex(segments, alignFirstEnabled = false) {
    if (!alignFirstEnabled || !Array.isArray(segments)) return -1;
    return segments.findIndex((segment) => (
      segment && !segment.disabled && Number.isFinite(Number(segment.start))
    ));
  }

  // 保留这个数值 helper 供已有调用方使用；SRT 导出本身不应把它从所有时间码中扣除。
  function getSrtExportOffset(segments, alignFirstEnabled = false) {
    const firstIndex = getSrtExportFirstIndex(segments, alignFirstEnabled);
    if (firstIndex < 0) return 0;
    return Math.max(0, Math.round(Number(segments[firstIndex].start)));
  }

  function effectiveColorName(segment, segments) {
    const direct = segment?.color?.name;
    if (typeof direct === 'string' && direct) return direct;
    const reference = segment?.color_ref;
    const headName = Number.isInteger(reference?.headIdx)
      ? segments?.[reference.headIdx]?.color?.name
      : null;
    if (typeof headName === 'string' && headName) return headName;
    return typeof reference?.name === 'string' && reference.name ? reference.name : null;
  }

  // 在字幕数组中插入新段后，所有指向插入点及其后方 head 的引用都右移。
  // headIdx 是数组下标，不随 Array.splice 自动更新；调用方必须在插入后立即调用。
  function shiftGroupReferenceIndices(segments, insertionIndex, delta = 1) {
    if (!Array.isArray(segments)) return 0;
    const pivot = Number(insertionIndex);
    const shift = Number(delta);
    if (!Number.isInteger(pivot) || !Number.isInteger(shift) || shift === 0) return 0;
    let changed = 0;
    segments.forEach((segment) => {
      ['sticker_ref', 'color_ref'].forEach((field) => {
        const reference = segment?.[field];
        if (!reference || !Number.isInteger(reference.headIdx) || reference.headIdx < pivot) return;
        reference.headIdx += shift;
        changed++;
      });
    });
    return changed;
  }

  // 兼容旧工程中因插入字幕导致的错位引用：引用自身保留了 head 的名称，
  // 可用它在当前条目之前寻找最近的同名 head。合法引用不做任何改动。
  function repairGroupReferenceIndices(segments) {
    if (!Array.isArray(segments)) return 0;
    const groups = [
      { head: 'sticker', reference: 'sticker_ref' },
      { head: 'color', reference: 'color_ref' },
    ];
    let repaired = 0;
    segments.forEach((segment, index) => {
      groups.forEach(({ head, reference }) => {
        const ref = segment?.[reference];
        if (!ref || !Number.isInteger(ref.headIdx)) return;
        const currentHead = segments[ref.headIdx]?.[head];
        if (currentHead && (!ref.name || currentHead.name === ref.name)) return;
        if (typeof ref.name !== 'string' || !ref.name) return;
        for (let candidate = index - 1; candidate >= 0; candidate--) {
          if (segments[candidate]?.[head]?.name !== ref.name) continue;
          if (ref.headIdx !== candidate) {
            ref.headIdx = candidate;
            repaired++;
          }
          break;
        }
      });
    });
    return repaired;
  }

  // 从字幕数组移除/迁出下标 index 的段后同步选择状态：该下标移出选中集，
  // 其后的选中项与 Shift 范围锚点前移一位，避免选中状态落到后面的字幕上。
  // selection 是会被原地修改的 Set；返回 { wasSelected, nextAnchor }。
  function shiftSelectionAfterRemoval(selection, anchorIndex, removedIndex) {
    // 用 Object.prototype.toString 判断 Set，兼容 vm 等跨 realm 环境。
    if (Object.prototype.toString.call(selection) !== '[object Set]' || !Number.isInteger(removedIndex)) {
      return { wasSelected: false, nextAnchor: Number.isInteger(anchorIndex) ? anchorIndex : -1 };
    }
    const wasSelected = selection.has(removedIndex);
    selection.delete(removedIndex);
    [...selection].forEach((idx) => {
      if (idx > removedIndex) {
        selection.delete(idx);
        selection.add(idx - 1);
      }
    });
    const anchor = Number.isInteger(anchorIndex) ? anchorIndex : -1;
    const nextAnchor = anchor === removedIndex ? -1
      : anchor > removedIndex ? anchor - 1 : anchor;
    return { wasSelected, nextAnchor };
  }

  function buildSrtPayload(segments, options = {}) {
    const source = Array.isArray(segments) ? segments : [];
    const colorName = typeof options.colorName === 'string' ? options.colorName : null;
    const timeOffset = Math.max(0, Math.round(Number(options.timeOffset)) || 0);
    const mapTime = typeof options.mapTime === 'function'
      ? options.mapTime
      : (timeMs) => Math.max(0, Math.round(Number(timeMs) || 0) - timeOffset);
    const formatTime = typeof options.formatTime === 'function'
      ? options.formatTime
      : (timeMs) => String(timeMs);
    const alignFirstStart = options.alignFirstStart === true;
    const firstEnabledIndex = Number.isInteger(options.firstEnabledIndex)
      ? options.firstEnabledIndex
      : getSrtExportFirstIndex(source, alignFirstStart);
    const keepDisabledPlaceholder = options.keepDisabledPlaceholder === true && !colorName;
    const speakerLabels = options.speakerLabelsEnabled === true
      ? normalizeSpeakerLabels(options.speakerLabels)
      : null;
    const speakerLabelSeparator = options.speakerLabelsEnabled === true
      ? normalizeSpeakerLabelSeparator(options.speakerLabelSeparator)
      : DEFAULT_SPEAKER_LABEL_SEPARATOR;
    const parts = [];
    let outputIndex = 0;
    // 颜色/说话人解析上下文：合并导出（主轨 + 叠加轨）时，叠加段的
    // color_ref 指向叠加轨自身数组，不能在合并后的大数组里按下标解析。
    const colorContextResolver = typeof options.colorContextResolver === 'function'
      ? options.colorContextResolver : () => source;
    source.forEach((segment, sourceIndex) => {
      if (!segment) return;
      const disabled = segment.disabled === true;
      if (disabled && !keepDisabledPlaceholder) return;
      const colorContext = colorContextResolver(segment) || source;
      if (!disabled && colorName) {
        const effectiveName = effectiveColorName(segment, colorContext);
        const matches = colorName === 'default' ? !effectiveName : effectiveName === colorName;
        if (!matches) return;
      }
      const mappedStart = Math.max(0, Math.round(Number(mapTime(segment.start)) || 0));
      const start = alignFirstStart && !disabled && sourceIndex === firstEnabledIndex ? 0 : mappedStart;
      const mappedEnd = Math.max(0, Math.round(Number(mapTime(segment.end)) || 0));
      const end = options.ensurePositiveDuration ? Math.max(start + 1, mappedEnd) : mappedEnd;
      outputIndex += 1;
      parts.push(String(outputIndex));
      parts.push(`${formatTime(start)} --> ${formatTime(end)}`);
      parts.push(disabled ? '' : speakerLabels
        ? formatSpeakerLabelledText(
          segment.text, segment, colorContext, speakerLabels, speakerLabelSeparator,
        )
        : String(segment.text || ''));
      parts.push('');
    });
    return parts.join('\n');
  }

  // ASS 默认字体按操作系统选择：Arial 对中文没有合适的字形回退，
  // 中文系统下默认字体应直接落到系统自带的 CJK 无衬线字体。
  function assDefaultFontFamily() {
    const nav = globalThis.navigator;
    const source = `${nav?.platform || ''} ${nav?.userAgent || ''}`.toLowerCase();
    if (/win/.test(source)) return 'Microsoft YaHei';
    if (/\bmac|iphone|ipad/.test(source)) return 'PingFang SC';
    return 'Noto Sans CJK SC';
  }
  const ASS_DEFAULT_FONT_FAMILY = assDefaultFontFamily();
  const ASS_DEFAULT_PREVIEW_FONT_SIZE = 18;
  const ASS_AUTO_FONT_SIZE_1080P = 72;
  // Fullscreen preview doubles the CSS size; Subtitle Edit calibration maps
  // that 36px default preview to ASS 72 at 1080p, hence the 4x ratio here.
  const ASS_PREVIEW_TO_ASS_SCALE = ASS_AUTO_FONT_SIZE_1080P / ASS_DEFAULT_PREVIEW_FONT_SIZE;
  const ASS_DEFAULT_COLOR = '#ffffff';
  const ASS_DEFAULT_PLAY_RES_X = 1920;
  const ASS_DEFAULT_PLAY_RES_Y = 1080;
  const ASS_REFERENCE_PLAY_RES_Y = 1080;
  const ASS_COLOR_STYLE_NAMES = Object.freeze(['yellow', 'green', 'red', 'purple', 'blue']);
  // The editor injects window.ASR_EDITOR_PALETTE from maw/colors.py before
  // this module runs. Keep a small fallback so the utility remains usable in
  // standalone tests and integrations that do not render the full template.
  const ASS_FALLBACK_COLOR_PALETTE = Object.freeze([
    Object.freeze({ name: 'yellow', value: '#c4a019' }),
    Object.freeze({ name: 'green', value: '#66bb6a' }),
    Object.freeze({ name: 'red', value: '#f07f6f' }),
    Object.freeze({ name: 'purple', value: '#bf89e6' }),
    Object.freeze({ name: 'blue', value: '#61a7fa' }),
  ]);
  const ASS_STYLE_FORMAT = 'Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding';
  const ASS_EVENT_FORMAT = 'Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text';

  const ASS_STYLE_LIBRARY_SCHEMA = 'moy.asr.ass_styles.v1';
  const ASS_STYLE_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/u;
  const ASS_STYLE_LIBRARY_MAX_NAME_LENGTH = 80;
  const ASS_STYLE_LIBRARY_MAX_FONT_LENGTH = 128;
  const ASS_STYLE_LIBRARY_MAX_TRANSFORM_LENGTH = 512;
  const ASS_COLOR_STYLE_VALUES = Object.freeze(['text', 'speaker', 'stroke', 'none']);

  function normalizeAssColorStyle(value) {
    if (value === 'underline') return 'text';
    return typeof value === 'string' && ASS_COLOR_STYLE_VALUES.includes(value) ? value : null;
  }

  const ASS_DEFAULT_STYLE = Object.freeze({
    id: 'default',
    name: 'SRT 默认',
    builtin: true,
    fontName: 'Arial',
    fontSize: 18,
    primaryColor: '#ffffff',
    secondaryColor: '#ffffff',
    outlineColor: '#000000',
    backColor: '#000000',
    bold: false,
    italic: false,
    underline: false,
    strikeOut: false,
    scaleX: 100,
    scaleY: 100,
    spacing: 0,
    angle: 0,
    borderStyle: 1,
    outline: 2,
    shadow: 0,
    alignment: 2,
    marginL: 10,
    marginR: 10,
    marginV: 40,
    encoding: 1,
  });
  // ASS 默认样式：字体按操作系统选择、默认加粗，字号按 1080p 参考基准 72，
  // 垂直边距放宽到 80；SRT 压制默认样式保持 Arial 18/40 不加粗。
  const ASS_DEFAULT_ASS_STYLE = Object.freeze({
    ...ASS_DEFAULT_STYLE,
    id: 'ass', name: 'ASS 默认样式',
    fontName: ASS_DEFAULT_FONT_FAMILY,
    bold: true,
    fontSize: 72, marginV: 80,
  });
  // ASS 副字幕默认样式：多重字幕的副语言轨在 ASS 导出与预览中共用一个
  // 样式（副字幕不支持颜色分组）；默认沿用 CSS 预览的副字幕黄色，字号约
  // 主样式的 75%，垂直边距按「主边距 80 + 1.2 × 主字号 72」固化在主字幕
  // 上方，与叠加字幕的默认锚定公式一致。
  const ASS_DEFAULT_EXTENSION_STYLE = Object.freeze({
    ...ASS_DEFAULT_STYLE,
    id: 'ass-extension', name: 'ASS 副字幕样式',
    fontName: ASS_DEFAULT_FONT_FAMILY,
    bold: true,
    primaryColor: '#ffd34d',
    fontSize: 54, marginV: 166,
  });
  const ASS_DEFAULT_ANIMATIONS = Object.freeze({
    fad: Object.freeze({ enabled: false, inMs: 250, outMs: 250 }),
    fade: Object.freeze({
      enabled: false, alpha1: 0, alpha2: 255, alpha3: 0,
      t1: 0, t2: 250, t3: 750, t4: 1000,
    }),
    move: Object.freeze({
      enabled: false, x1: 0, y1: 0, x2: 0, y2: 0, t1: 0, t2: 1000,
    }),
    t: Object.freeze({ enabled: false, startMs: 0, endMs: 1000, accel: 1, tags: '' }),
  });
  const ASS_DEFAULT_PROFILE = Object.freeze({
    id: 'ass', name: 'ASS 输出方案', builtin: true, styleId: 'ass',
    animations: ASS_DEFAULT_ANIMATIONS,
  });

  function cloneJsonValue(value) {
    if (value === undefined) return undefined;
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return null; }
  }

  function normalizeAssStyleId(value, fallback = '') {
    const candidate = String(value ?? '').trim().toLowerCase();
    return ASS_STYLE_ID_RE.test(candidate) ? candidate : fallback;
  }

  function normalizeAssLibraryText(value, fallback = '', limit = ASS_STYLE_LIBRARY_MAX_NAME_LENGTH) {
    const normalized = String(value ?? '')
      .replace(/[\u0000-\u001f\u007f]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .replace(/,/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, limit);
    return normalized || fallback;
  }

  function normalizeAssAnimationText(value, fallback = '', limit = ASS_STYLE_LIBRARY_MAX_TRANSFORM_LENGTH) {
    const normalized = String(value ?? '')
      .replace(/[\u0000-\u001f\u007f]/gu, ' ')
      .replace(/[{}]/gu, '')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, limit);
    return normalized || fallback;
  }

  function normalizeAssLibraryColor(value, fallback = '#ffffff') {
    const candidate = String(value ?? '').trim().toLowerCase();
    return /^#[0-9a-f]{6}$/iu.test(candidate) ? candidate : fallback;
  }

  function normalizeAssLibraryNumber(value, fallback, min, max, integer = true) {
    const numeric = Number(value);
    const safe = Number.isFinite(numeric) ? numeric : Number(fallback);
    const clamped = Math.min(max, Math.max(min, safe));
    return integer ? Math.round(clamped) : clamped;
  }

  function normalizeAssLibraryBoolean(value, fallback = false) {
    return typeof value === 'boolean' ? value : fallback;
  }

  function normalizeAssStyle(value, fallback = ASS_DEFAULT_ASS_STYLE, styleId = '') {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const base = { ...fallback };
    const resolvedId = normalizeAssStyleId(styleId || source.id || fallback.id, fallback.id || 'ass');
    return {
      ...base,
      id: resolvedId,
      name: normalizeAssLibraryText(source.name, fallback.name || '样式'),
      builtin: Boolean(fallback.builtin),
      fontName: normalizeAssLibraryText(source.fontName, fallback.fontName || ASS_DEFAULT_FONT_FAMILY, ASS_STYLE_LIBRARY_MAX_FONT_LENGTH),
      fontSize: normalizeAssLibraryNumber(source.fontSize, fallback.fontSize || 18, 1, 512),
      primaryColor: normalizeAssLibraryColor(source.primaryColor, fallback.primaryColor || '#ffffff'),
      secondaryColor: normalizeAssLibraryColor(source.secondaryColor, fallback.secondaryColor || '#ffffff'),
      outlineColor: normalizeAssLibraryColor(source.outlineColor, fallback.outlineColor || '#000000'),
      backColor: normalizeAssLibraryColor(source.backColor, fallback.backColor || '#000000'),
      bold: normalizeAssLibraryBoolean(source.bold, Boolean(fallback.bold)),
      italic: normalizeAssLibraryBoolean(source.italic, Boolean(fallback.italic)),
      underline: normalizeAssLibraryBoolean(source.underline, Boolean(fallback.underline)),
      strikeOut: normalizeAssLibraryBoolean(source.strikeOut, Boolean(fallback.strikeOut)),
      scaleX: normalizeAssLibraryNumber(source.scaleX, fallback.scaleX ?? 100, 0, 1000),
      scaleY: normalizeAssLibraryNumber(source.scaleY, fallback.scaleY ?? 100, 0, 1000),
      spacing: normalizeAssLibraryNumber(source.spacing, fallback.spacing ?? 0, -100, 100),
      angle: normalizeAssLibraryNumber(source.angle, fallback.angle ?? 0, -360, 360),
      borderStyle: normalizeAssLibraryNumber(source.borderStyle, fallback.borderStyle ?? 1, 1, 4),
      outline: normalizeAssLibraryNumber(source.outline, fallback.outline ?? 2, 0, 100),
      shadow: normalizeAssLibraryNumber(source.shadow, fallback.shadow ?? 0, 0, 100),
      alignment: normalizeAssLibraryNumber(source.alignment, fallback.alignment ?? 2, 1, 9),
      marginL: normalizeAssLibraryNumber(source.marginL, fallback.marginL ?? 10, 0, 9999),
      marginR: normalizeAssLibraryNumber(source.marginR, fallback.marginR ?? 10, 0, 9999),
      marginV: normalizeAssLibraryNumber(source.marginV, fallback.marginV ?? 40, 0, 9999),
      encoding: normalizeAssLibraryNumber(source.encoding, fallback.encoding ?? 1, 0, 255),
    };
  }

  function normalizeAssAnimations(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const fad = source.fad && typeof source.fad === 'object' ? source.fad : {};
    const fade = source.fade && typeof source.fade === 'object' ? source.fade : {};
    const move = source.move && typeof source.move === 'object' ? source.move : {};
    const transform = source.t && typeof source.t === 'object' ? source.t : {};
    return {
      fad: {
        enabled: normalizeAssLibraryBoolean(fad.enabled),
        inMs: normalizeAssLibraryNumber(fad.inMs, 250, 0, 60000),
        outMs: normalizeAssLibraryNumber(fad.outMs, 250, 0, 60000),
      },
      fade: (() => {
        const t1 = normalizeAssLibraryNumber(fade.t1, 0, 0, 60000);
        const t2 = Math.max(t1, normalizeAssLibraryNumber(fade.t2, 250, 0, 60000));
        const t3 = Math.max(t2, normalizeAssLibraryNumber(fade.t3, 750, 0, 60000));
        const t4 = Math.max(t3, normalizeAssLibraryNumber(fade.t4, 1000, 0, 60000));
        return {
          enabled: normalizeAssLibraryBoolean(fade.enabled),
          alpha1: normalizeAssLibraryNumber(fade.alpha1, 0, 0, 255),
          alpha2: normalizeAssLibraryNumber(fade.alpha2, 255, 0, 255),
          alpha3: normalizeAssLibraryNumber(fade.alpha3, 0, 0, 255),
          t1, t2, t3, t4,
        };
      })(),
      move: {
        enabled: normalizeAssLibraryBoolean(move.enabled),
        x1: normalizeAssLibraryNumber(move.x1, 0, -65535, 65535),
        y1: normalizeAssLibraryNumber(move.y1, 0, -65535, 65535),
        x2: normalizeAssLibraryNumber(move.x2, 0, -65535, 65535),
        y2: normalizeAssLibraryNumber(move.y2, 0, -65535, 65535),
        t1: normalizeAssLibraryNumber(move.t1, 0, 0, 60000),
        t2: Math.max(
          normalizeAssLibraryNumber(move.t1, 0, 0, 60000),
          normalizeAssLibraryNumber(move.t2, 1000, 0, 60000),
        ),
      },
      t: {
        enabled: normalizeAssLibraryBoolean(transform.enabled),
        startMs: normalizeAssLibraryNumber(transform.startMs, 0, 0, 60000),
        endMs: Math.max(
          normalizeAssLibraryNumber(transform.startMs, 0, 0, 60000),
          normalizeAssLibraryNumber(transform.endMs, 1000, 0, 60000),
        ),
        accel: normalizeAssLibraryNumber(transform.accel, 1, 0.01, 100, false),
        tags: normalizeAssAnimationText(transform.tags, '', ASS_STYLE_LIBRARY_MAX_TRANSFORM_LENGTH),
      },
    };
  }

  function normalizeAssProfile(value, fallback = ASS_DEFAULT_PROFILE, profileId = '') {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const resolvedId = normalizeAssStyleId(profileId || source.id || fallback.id, fallback.id || 'ass');
    return {
      ...fallback,
      id: resolvedId,
      name: normalizeAssLibraryText(source.name, fallback.name || 'ASS'),
      builtin: Boolean(fallback.builtin),
      styleId: normalizeAssStyleId(source.styleId, fallback.styleId || 'ass') || 'ass',
      animations: normalizeAssAnimations(source.animations),
    };
  }

  function defaultAssStyleLibrary() {
    return {
      schema: ASS_STYLE_LIBRARY_SCHEMA,
      version: 1,
      styles: [
        cloneJsonValue(ASS_DEFAULT_STYLE),
        cloneJsonValue(ASS_DEFAULT_ASS_STYLE),
        cloneJsonValue(ASS_DEFAULT_EXTENSION_STYLE),
      ],
      assProfiles: [cloneJsonValue(ASS_DEFAULT_PROFILE)],
      assignments: { srtBurnStyleId: 'default', assExportProfileId: 'ass', assExtensionStyleId: 'ass-extension' },
    };
  }

  function normalizeAssStyleLibrary(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const styleMap = new Map([
      ['default', normalizeAssStyle(ASS_DEFAULT_STYLE, ASS_DEFAULT_STYLE, 'default')],
      ['ass', normalizeAssStyle(ASS_DEFAULT_ASS_STYLE, ASS_DEFAULT_ASS_STYLE, 'ass')],
      ['ass-extension', normalizeAssStyle(ASS_DEFAULT_EXTENSION_STYLE, ASS_DEFAULT_EXTENSION_STYLE, 'ass-extension')],
    ]);
    if (Array.isArray(source.styles)) {
      source.styles.forEach((raw) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
        const id = normalizeAssStyleId(raw.id);
        if (!id) return;
        const fallback = styleMap.get(id) || { ...ASS_DEFAULT_ASS_STYLE, id, name: '自定义样式', builtin: false };
        const normalized = normalizeAssStyle(raw, fallback, id);
        if (id !== 'default' && id !== 'ass' && id !== 'ass-extension') normalized.builtin = false;
        styleMap.set(id, normalized);
      });
    }
    const styles = [...styleMap.values()].slice(0, 64);
    // 内置条目若仍使用旧默认名，迁移到当前默认名；用户自定义过的名字不动。
    const legacyBuiltinStyleNames = { ass: 'ASS' };
    styles.forEach((style) => {
      const legacy = legacyBuiltinStyleNames[style.id];
      if (legacy && style.name === legacy) {
        style.name = (style.id === 'ass' ? ASS_DEFAULT_ASS_STYLE : ASS_DEFAULT_STYLE).name;
      }
    });
    const profileMap = new Map([
      ['ass', normalizeAssProfile(ASS_DEFAULT_PROFILE, ASS_DEFAULT_PROFILE, 'ass')],
    ]);
    if (Array.isArray(source.assProfiles)) {
      source.assProfiles.forEach((raw) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
        const id = normalizeAssStyleId(raw.id);
        if (!id) return;
        const fallback = profileMap.get(id) || { ...ASS_DEFAULT_PROFILE, id, name: '自定义 ASS', builtin: false };
        const normalized = normalizeAssProfile(raw, fallback, id);
        if (id !== 'ass') normalized.builtin = false;
        profileMap.set(id, normalized);
      });
    }
    const styleIds = new Set(styles.map((style) => style.id));
    const profiles = [...profileMap.values()].slice(0, 64).map((profile) => ({
      ...profile,
      styleId: styleIds.has(profile.styleId) ? profile.styleId : 'ass',
    }));
    // 内置方案旧默认名迁移（同上，用户自定义过的名字不动）。
    profiles.forEach((profile) => {
      if (profile.id === 'ass' && profile.name === 'ASS') {
        profile.name = ASS_DEFAULT_PROFILE.name;
      }
    });
    const assignments = source.assignments && typeof source.assignments === 'object'
      ? source.assignments : {};
    const srtBurnStyleId = styleIds.has(normalizeAssStyleId(assignments.srtBurnStyleId))
      ? normalizeAssStyleId(assignments.srtBurnStyleId) : 'default';
    const profileIds = new Set(profiles.map((profile) => profile.id));
    const assExportProfileId = profileIds.has(normalizeAssStyleId(assignments.assExportProfileId))
      ? normalizeAssStyleId(assignments.assExportProfileId) : 'ass';
    const assExtensionStyleId = styleIds.has(normalizeAssStyleId(assignments.assExtensionStyleId))
      ? normalizeAssStyleId(assignments.assExtensionStyleId) : 'ass-extension';
    return {
      schema: ASS_STYLE_LIBRARY_SCHEMA,
      version: 1,
      styles,
      assProfiles: profiles.length ? profiles : [normalizeAssProfile(ASS_DEFAULT_PROFILE)],
      assignments: { srtBurnStyleId, assExportProfileId, assExtensionStyleId },
    };
  }

  function assStyleForId(library, styleId) {
    const normalized = normalizeAssStyleLibrary(library);
    return normalized.styles.find((style) => style.id === normalizeAssStyleId(styleId, 'default'))
      || normalized.styles[0];
  }

  function assProfileForId(library, profileId) {
    const normalized = normalizeAssStyleLibrary(library);
    return normalized.assProfiles.find((profile) => profile.id === normalizeAssStyleId(profileId, 'ass'))
      || normalized.assProfiles[0];
  }

  function assStyleLine(style, name = 'Default', fontSizeOverride = null) {
    const normalized = normalizeAssStyle(style);
    const boolValue = (key) => normalized[key] ? -1 : 0;
    const values = [
      name,
      normalized.fontName,
      fontSizeOverride || normalized.fontSize,
      assColorFromHex(normalized.primaryColor),
      assColorFromHex(normalized.secondaryColor),
      assColorFromHex(normalized.outlineColor),
      assColorFromHex(normalized.backColor),
      boolValue('bold'),
      boolValue('italic'),
      boolValue('underline'),
      boolValue('strikeOut'),
      normalized.scaleX,
      normalized.scaleY,
      normalized.spacing,
      normalized.angle,
      normalized.borderStyle,
      normalized.outline,
      normalized.shadow,
      normalized.alignment,
      normalized.marginL,
      normalized.marginR,
      normalized.marginV,
      normalized.encoding,
    ];
    return `Style: ${values.join(',')}`;
  }

  function assAnimationOverrideTags(profile, { includeMove = true } = {}) {
    const animations = normalizeAssAnimations(profile?.animations);
    const tags = [];
    // libass/playback behaviour is undefined when both fade forms are present.
    // The more expressive form wins, while the simple fad remains the normal
    // one-click path in the style manager.
    if (animations.fade.enabled) {
      const { alpha1, alpha2, alpha3, t1, t2, t3, t4 } = animations.fade;
      tags.push(`\\fade(${alpha1},${alpha2},${alpha3},${t1},${t2},${t3},${t4})`);
    } else if (animations.fad.enabled) {
      tags.push(`\\fad(${animations.fad.inMs},${animations.fad.outMs})`);
    }
    // \move 的坐标是主字幕画布上的绝对 PlayRes 坐标；叠加轨的锚定由
    // MarginV 堆叠负责，不跟随 move（includeMove: false 时省略）。
    if (includeMove && animations.move.enabled) {
      const { x1, y1, x2, y2, t1, t2 } = animations.move;
      tags.push(`\\move(${x1},${y1},${x2},${y2},${t1},${t2})`);
    }
    if (animations.t.enabled && animations.t.tags) {
      const { startMs, endMs, accel, tags: transformTags } = animations.t;
      tags.push(`\\t(${startMs},${endMs},${accel},${transformTags})`);
    }
    return tags.join('');
  }

  function assColorFromTag(value) {
    const raw = String(value ?? '').trim().replace(/^&H/iu, '').replace(/&$/u, '');
    if (!/^[0-9a-f]{6,8}$/iu.test(raw)) return null;
    const hex = raw.slice(-6);
    return `#${hex.slice(4, 6)}${hex.slice(2, 4)}${hex.slice(0, 2)}`.toLowerCase();
  }

  function assTransformStyleTargets(value) {
    const source = String(value ?? '').replace(/[{}]/gu, '');
    const target = {};
    const number = (pattern, key, min = -Infinity, max = Infinity) => {
      const match = pattern.exec(source);
      if (!match) return;
      const numeric = Number(match[1]);
      if (Number.isFinite(numeric)) target[key] = Math.min(max, Math.max(min, numeric));
    };
    number(/\\fs(-?[0-9]+(?:\\.[0-9]+)?)/iu, 'fontSize', 1, 512);
    number(/\\fscx(-?[0-9]+(?:\\.[0-9]+)?)/iu, 'scaleX', 0, 1000);
    number(/\\fscy(-?[0-9]+(?:\\.[0-9]+)?)/iu, 'scaleY', 0, 1000);
    number(/\\fsp(-?[0-9]+(?:\\.[0-9]+)?)/iu, 'spacing', -100, 100);
    number(/\\(?:frz|fr)(-?[0-9]+(?:\\.[0-9]+)?)/iu, 'angle', -360, 360);
    number(/\\frx(-?[0-9]+(?:\\.[0-9]+)?)/iu, 'rotationX', -360, 360);
    number(/\\fry(-?[0-9]+(?:\\.[0-9]+)?)/iu, 'rotationY', -360, 360);
    number(/\\bord(-?[0-9]+(?:\\.[0-9]+)?)/iu, 'outline', 0, 100);
    number(/\\(?:xbord|ybord)(-?[0-9]+(?:\\.[0-9]+)?)/iu, 'outline', 0, 100);
    number(/\\shad(-?[0-9]+(?:\\.[0-9]+)?)/iu, 'shadow', 0, 100);
    number(/\\(?:b)(-?[0-9]+)/iu, 'bold', 0, 1);
    number(/\\(?:i)(-?[0-9]+)/iu, 'italic', 0, 1);
    number(/\\(?:u)(-?[0-9]+)/iu, 'underline', 0, 1);
    number(/\\(?:s)(-?[0-9]+)/iu, 'strikeOut', 0, 1);
    const primaryColor = /\\(?:1c|c)(&H[0-9a-f]{6,8}&?)/iu.exec(source);
    if (primaryColor) target.primaryColor = assColorFromTag(primaryColor[1]);
    const outlineColor = /\\3c(&H[0-9a-f]{6,8}&?)/iu.exec(source);
    if (outlineColor) target.outlineColor = assColorFromTag(outlineColor[1]);
    const alpha = /\\alpha(&H[0-9a-f]{2}&?)/iu.exec(source)
      || /\\1a(&H[0-9a-f]{2}&?)/iu.exec(source);
    if (alpha) {
      const valueText = alpha[1].replace(/^&H|&$/giu, '');
      const numeric = Number.parseInt(valueText, 16);
      if (Number.isFinite(numeric)) target.alpha = Math.min(255, Math.max(0, numeric));
    }
    return target;
  }

  function interpolateAssColor(start, end, progress) {
    const from = normalizeAssLibraryColor(start, '#ffffff');
    const to = normalizeAssLibraryColor(end, from);
    const channels = [1, 3, 5].map((offset) => {
      const a = Number.parseInt(from.slice(offset, offset + 2), 16);
      const b = Number.parseInt(to.slice(offset, offset + 2), 16);
      return Math.round(a + (b - a) * progress).toString(16).padStart(2, '0');
    });
    return `#${channels.join('')}`;
  }

  function assPreviewStyleAt(style, transformTags, progress = 1) {
    const base = normalizeAssStyle(style);
    const target = assTransformStyleTargets(transformTags);
    const amount = Math.min(1, Math.max(0, Number(progress) || 0));
    const result = { ...base, alpha: 0, rotationX: 0, rotationY: 0 };
    const numericKeys = [
      'fontSize', 'scaleX', 'scaleY', 'spacing', 'angle', 'outline', 'shadow',
      'rotationX', 'rotationY', 'alpha',
    ];
    numericKeys.forEach((key) => {
      if (target[key] === undefined) return;
      const start = Number(result[key]) || 0;
      result[key] = start + (Number(target[key]) - start) * amount;
    });
    ['primaryColor', 'outlineColor'].forEach((key) => {
      if (target[key]) result[key] = interpolateAssColor(result[key], target[key], amount);
    });
    ['bold', 'italic', 'underline', 'strikeOut'].forEach((key) => {
      if (target[key] !== undefined) result[key] = amount >= 0.5 ? Boolean(target[key]) : Boolean(base[key]);
    });
    return result;
  }

  function assPreviewAnimationState(profile, elapsedMs, durationMs, {
    playResX = ASS_DEFAULT_PLAY_RES_X,
    playResY = ASS_DEFAULT_PLAY_RES_Y,
    stageWidth = 0,
    stageHeight = 0,
  } = {}) {
    const animations = normalizeAssAnimations(profile?.animations);
    const elapsed = Math.max(0, Number(elapsedMs) || 0);
    const duration = Math.max(1, Number(durationMs) || 1);
    let opacity = 1;
    const interpolate = (start, end, from, to) => {
      if (to <= from) return elapsed >= to ? end : start;
      const amount = Math.min(1, Math.max(0, (elapsed - from) / (to - from)));
      return start + (end - start) * amount;
    };
    if (animations.fade.enabled) {
      const fade = animations.fade;
      let alpha = fade.alpha1;
      if (elapsed < fade.t1) alpha = fade.alpha1;
      else if (elapsed < fade.t2) alpha = interpolate(fade.alpha1, fade.alpha2, fade.t1, fade.t2);
      else if (elapsed < fade.t3) alpha = fade.alpha2;
      else if (elapsed < fade.t4) alpha = interpolate(fade.alpha2, fade.alpha3, fade.t3, fade.t4);
      else alpha = fade.alpha3;
      opacity = 1 - Math.min(255, Math.max(0, alpha)) / 255;
    } else if (animations.fad.enabled) {
      const fadeIn = animations.fad.inMs > 0 && elapsed < animations.fad.inMs
        ? elapsed / animations.fad.inMs : 1;
      const fadeOutStart = Math.max(0, duration - animations.fad.outMs);
      const fadeOut = animations.fad.outMs > 0 && elapsed > fadeOutStart
        ? Math.max(0, (duration - elapsed) / animations.fad.outMs) : 1;
      opacity = Math.min(1, fadeIn, fadeOut);
    }
    let moveX = 0;
    let moveY = 0;
    if (animations.move.enabled) {
      const move = animations.move;
      const amount = move.t2 <= move.t1
        ? (elapsed >= move.t2 ? 1 : 0)
        : Math.min(1, Math.max(0, (elapsed - move.t1) / (move.t2 - move.t1)));
      moveX = move.x1 + (move.x2 - move.x1) * amount;
      moveY = move.y1 + (move.y2 - move.y1) * amount;
    }
    let transformProgress = null;
    if (animations.t.enabled && animations.t.tags) {
      const start = animations.t.startMs;
      const end = animations.t.endMs;
      const linear = end <= start
        ? (elapsed >= end ? 1 : 0)
        : Math.min(1, Math.max(0, (elapsed - start) / (end - start)));
      transformProgress = Math.pow(linear, Math.max(0.01, animations.t.accel));
    }
    const safePlayResX = Math.max(1, Number(playResX) || ASS_DEFAULT_PLAY_RES_X);
    const safePlayResY = Math.max(1, Number(playResY) || ASS_DEFAULT_PLAY_RES_Y);
    return {
      opacity,
      moveX,
      moveY,
      moveOffsetX: animations.move.enabled
        ? (moveX - animations.move.x1) * (Number(stageWidth) || 0) / safePlayResX : 0,
      moveOffsetY: animations.move.enabled
        ? (moveY - animations.move.y1) * (Number(stageHeight) || 0) / safePlayResY : 0,
      transformProgress,
    };
  }

  function normalizeAssFontFamily(value) {
    const key = String(value ?? '').trim();
    const family = ({
      default: ASS_DEFAULT_FONT_FAMILY,
      yahei: 'Microsoft YaHei',
      hei: 'SimHei',
      song: 'SimSun',
      sans: 'Arial',
    })[key] || key || ASS_DEFAULT_FONT_FAMILY;
    // Fontname is a comma-delimited ASS style field. Keep custom local font
    // names intact where possible, but do not let a malformed name shift the
    // remaining style columns.
    return family.replace(/[\r\n,]/g, ' ').replace(/\s+/g, ' ').trim() || ASS_DEFAULT_FONT_FAMILY;
  }

  function assColorFromHex(value, fallback = ASS_DEFAULT_COLOR) {
    const raw = String(value ?? '').trim();
    const fallbackColor = String(fallback ?? ASS_DEFAULT_COLOR).trim();
    const hex = /^#[0-9a-f]{6}$/i.test(raw) ? raw
      : (/^#[0-9a-f]{6}$/i.test(fallbackColor) ? fallbackColor : ASS_DEFAULT_COLOR);
    // ASS stores colours as &HAABBGGRR; AA=00 is fully opaque.
    return `&H00${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`.toUpperCase();
  }

  function assOverrideColorFromHex(value, fallback = ASS_DEFAULT_COLOR) {
    // Override tags use the trailing ampersand as their colour terminator;
    // style fields intentionally keep the legacy value without it.
    return `${assColorFromHex(value, fallback)}&`;
  }

  function normalizeAssTimeMs(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : 0;
  }

  function formatAssTime(ms) {
    const numeric = Number(ms);
    const centiseconds = Number.isFinite(numeric)
      ? Math.max(0, Math.round(numeric / 10)) : 0;
    const hours = Math.floor(centiseconds / 360000);
    const minutes = Math.floor((centiseconds % 360000) / 6000);
    const seconds = Math.floor((centiseconds % 6000) / 100);
    const hundredths = centiseconds % 100;
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`;
  }

  function escapeAssText(text) {
    return String(text ?? '')
      .replace(/\r\n?/g, '\n')
      .replace(/\\/g, '\\\\')
      .replace(/{/g, '\\{')
      .replace(/}/g, '\\}')
      .replace(/\n/g, '\\N');
  }

  function normalizeAssFontSize(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return ASS_AUTO_FONT_SIZE_1080P;
    return Math.min(512, Math.max(1, Math.round(numeric)));
  }

  function resolveAssFontSize(value, playResY) {
    const numericPreviewSize = Number(value);
    const previewSize = Number.isFinite(numericPreviewSize) && numericPreviewSize > 0
      ? numericPreviewSize : ASS_DEFAULT_PREVIEW_FONT_SIZE;
    const numericPlayResY = Number(playResY);
    const scale = Number.isFinite(numericPlayResY) && numericPlayResY > 0
      ? numericPlayResY / ASS_REFERENCE_PLAY_RES_Y : 1;
    return normalizeAssFontSize(previewSize * ASS_PREVIEW_TO_ASS_SCALE * scale);
  }

  function normalizeAssDimension(value, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
    return Math.min(65535, Math.max(1, Math.round(numeric)));
  }

  function normalizeAssPlayResolution(width, height) {
    const numericWidth = Number(width);
    const numericHeight = Number(height);
    if (!Number.isFinite(numericWidth) || numericWidth <= 0
        || !Number.isFinite(numericHeight) || numericHeight <= 0) {
      return { width: ASS_DEFAULT_PLAY_RES_X, height: ASS_DEFAULT_PLAY_RES_Y };
    }
    return {
      width: normalizeAssDimension(numericWidth, ASS_DEFAULT_PLAY_RES_X),
      height: normalizeAssDimension(numericHeight, ASS_DEFAULT_PLAY_RES_Y),
    };
  }

  function normalizeAssHeaderValue(value, fallback = 'MAW') {
    const normalized = String(value ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return normalized || fallback;
  }

  function normalizeAssEventField(value) {
    return String(value ?? '')
      .replace(/[\r\n,]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeAssColorStyles(value) {
    const injected = Array.isArray(window.ASR_EDITOR_PALETTE)
      ? window.ASR_EDITOR_PALETTE : ASS_FALLBACK_COLOR_PALETTE;
    const source = Array.isArray(value) ? value : injected;
    const byName = new Map(source
      .filter((entry) => entry && typeof entry.name === 'string')
      .map((entry) => [entry.name, entry.value]));
    return ASS_COLOR_STYLE_NAMES.map((name) => {
      const fallback = ASS_FALLBACK_COLOR_PALETTE.find((item) => item.name === name)?.value
        || ASS_DEFAULT_COLOR;
      const value = normalizeAssLibraryColor(byName.get(name), fallback);
      return { name, value, assValue: assColorFromHex(value) };
    });
  }

  function assStyleFromAppearance(appearance, resolution) {
    return {
      ...ASS_DEFAULT_ASS_STYLE,
      fontName: normalizeAssFontFamily(appearance?.font_family),
      fontSize: resolveAssFontSize(appearance?.font_size, resolution?.height),
      primaryColor: /^#[0-9a-f]{6}$/iu.test(String(appearance?.color || ''))
        ? String(appearance.color).toLowerCase() : ASS_DEFAULT_COLOR,
    };
  }

  function assStyleVariant(style, paletteValue, colorStyle) {
    const variant = { ...style };
    if (colorStyle === 'stroke') {
      variant.outlineColor = paletteValue;
    } else if (colorStyle === 'text') {
      variant.primaryColor = paletteValue;
      variant.secondaryColor = paletteValue;
    }
    return variant;
  }

  function assEventText({ segment, text, speakerName, speakerLabelSeparator, colorName,
    colorStyles, style, colorStyle, speakerLabels, assMode }) {
    const content = String(text ?? '');
    if (!speakerLabels || !speakerName) return escapeAssText(content);
    const paletteSpeakerColor = colorStyles.find((item) => item.name === colorName)?.value
      || style.primaryColor;
    // ASS can reproduce the existing text-colour mapping and stroke-colour
    // mapping, but a coloured underline is not representable without also
    // changing the glyph colour.  In stroke mode keep the speaker label in
    // the effective base colour so only the outline follows the palette.
    const speakerColor = colorStyle === 'text' || colorStyle === 'speaker'
      ? paletteSpeakerColor : style.primaryColor;
    // The event style already carries the effective ASS text colour.  Reusing
    // the speaker palette here would also colour the whole cue when the old
    // CSS colour preview is disabled, instead of limiting the override to the
    // speaker label.
    const eventTextColor = style.primaryColor;
    const label = `${speakerName}${speakerLabelSeparator}`;
    if (!assMode) return escapeAssText(`${label}${content}`);
    return `{\\c${assOverrideColorFromHex(speakerColor)}}${escapeAssText(label)}{\\c${assOverrideColorFromHex(eventTextColor)}}${escapeAssText(content)}`;
  }

  function buildAssPayload(segments, options = {}) {
    const source = Array.isArray(segments) ? segments : [];
    const appearance = options.appearance && typeof options.appearance === 'object'
      ? options.appearance : {};
    const fontFamily = normalizeAssFontFamily(
      appearance.font_family ?? options.fontFamily,
    );
    const mediaMetadata = options.mediaMetadata && typeof options.mediaMetadata === 'object'
      ? options.mediaMetadata : {};
    const resolution = normalizeAssPlayResolution(
      options.playResX ?? options.videoWidth ?? mediaMetadata.video_width,
      options.playResY ?? options.videoHeight ?? mediaMetadata.video_height,
    );
    const profile = options.assProfile && typeof options.assProfile === 'object'
      ? normalizeAssProfile(options.assProfile) : null;
    const baseStyle = profile
      ? normalizeAssStyle(options.assStyle, ASS_DEFAULT_ASS_STYLE, options.assStyle?.id || 'ass')
      : assStyleFromAppearance({
        ...appearance,
        font_family: appearance.font_family ?? options.fontFamily,
        font_size: appearance.font_size ?? options.fontSize,
        color: appearance.color ?? options.color,
      }, resolution);
    // A library style stores its font size against the shared 1080p reference
    // (the ASS preview scales by the same reference).  Export must rescale it
    // to the target PlayResY, or a 4K project renders subtitles half size.
    // The legacy appearance-based style below is already calibrated by
    // resolveAssFontSize and must not be scaled again.
    const fontSize = profile
      ? normalizeAssFontSize(baseStyle.fontSize * resolution.height / ASS_REFERENCE_PLAY_RES_Y)
      : normalizeAssFontSize(baseStyle.fontSize);
    const title = normalizeAssHeaderValue(options.title ?? options.projectName);
    const colorStyles = normalizeAssColorStyles(options.colorStyles);
    // ASS 的颜色映射只由 ass_color_style 驱动（text / speaker / stroke / none），与 CSS
    // 预览的 color_style（underline / text / stroke）和 color_underline 开关
    // 是两套语义；color_underline 只控制 CSS 预览，不参与 ASS 导出。
    const colorStyle = normalizeAssColorStyle(appearance.ass_color_style) || 'text';
    const assMode = Boolean(profile);
    const numericTimeOffset = Number(options.timeOffset);
    const timeOffset = Number.isFinite(numericTimeOffset)
      ? Math.max(0, Math.round(numericTimeOffset)) : 0;
    const mapTime = typeof options.mapTime === 'function'
      ? options.mapTime
      : (timeMs) => Math.max(0, Math.round(Number(timeMs) || 0) - timeOffset);
    const alignFirstStart = options.alignFirstStart === true;
    const firstEnabledIndex = Number.isInteger(options.firstEnabledIndex)
      ? options.firstEnabledIndex
      : getSrtExportFirstIndex(source, alignFirstStart);
    const speakerLabels = options.speakerLabelsEnabled === true
      ? normalizeSpeakerLabels(options.speakerLabels)
      : null;
    const speakerLabelSeparator = options.speakerLabelsEnabled === true
      ? normalizeSpeakerLabelSeparator(options.speakerLabelSeparator)
      : DEFAULT_SPEAKER_LABEL_SEPARATOR;
    const events = [];
    // 颜色样式只有在 ASS 能表达为整句样式（text / stroke）时才生成
    // 调色板样式；speaker 只给说话人前缀加局部颜色，none 回落 Default。
    const assColorGroupsSupported = colorStyle === 'text' || colorStyle === 'stroke';

    // 主轨事件：Layer 0，底部居中（Default 样式自带对齐）。
    source.forEach((segment, sourceIndex) => {
      if (!segment || segment.disabled === true) return;
      const rawStart = normalizeAssTimeMs(mapTime(segment.start));
      const rawEnd = normalizeAssTimeMs(mapTime(segment.end));
      const start = alignFirstStart && sourceIndex === firstEnabledIndex ? 0 : rawStart;
      // ASS only keeps centiseconds. Ensure a one-centisecond event even when
      // an imported/edited cue is shorter than that precision.
      const startCentiseconds = Math.max(0, Math.round(start / 10));
      const endCentiseconds = Math.max(startCentiseconds + 1, Math.round(rawEnd / 10));
      const speakerName = speakerLabels
        ? speakerLabelForSegment(segment, source, speakerLabels) : '';
      const text = speakerLabels
        ? formatSpeakerLabelledText(
          segment.text, segment, source, speakerLabels, speakerLabelSeparator,
        )
        : String(segment.text ?? '');
      const colorName = effectiveColorName(segment, source);
      const styleName = assColorGroupsSupported && ASS_COLOR_STYLE_NAMES.includes(colorName)
        ? colorName.toUpperCase() : 'Default';
      const styleForEvent = assMode && styleName !== 'Default'
        ? assStyleVariant(baseStyle, colorStyles.find((item) => item.name === colorName)?.value || '#ffffff', colorStyle)
        : baseStyle;
      const eventText = assEventText({
        segment,
        text: speakerLabels ? String(segment.text ?? '') : text,
        speakerName,
        speakerLabelSeparator,
        colorName,
        colorStyles,
        style: styleForEvent,
        colorStyle,
        speakerLabels,
        assMode,
      });
      const animationTags = assMode ? assAnimationOverrideTags(profile) : '';
      const decoratedText = animationTags ? `{${animationTags}}${eventText}` : eventText;
      events.push(
        `Dialogue: 0,${formatAssTime(startCentiseconds * 10)},${formatAssTime(endCentiseconds * 10)},${styleName},${normalizeAssEventField(speakerName)},0,0,0,,${decoratedText}`,
      );
    });

    // 副字幕轨（多重字幕）：所有副字幕共用一个样式（不支持颜色分组），
    // 事件引用独立 Extension 样式，边距/对齐完全由该样式决定。
    // \fad/\fade/\t 逐句应用；\move 的绝对坐标只属于主字幕。
    const extensionSource = Array.isArray(options.extensionSegments)
      ? options.extensionSegments : [];
    const hasExtensionCues = extensionSource.some((segment) => segment && segment.disabled !== true);
    const extensionStyle = assMode && options.assExtensionStyle && typeof options.assExtensionStyle === 'object'
      ? normalizeAssStyle(options.assExtensionStyle, ASS_DEFAULT_EXTENSION_STYLE, options.assExtensionStyle.id || 'ass-extension')
      : null;
    const extensionScaledFontSize = extensionStyle
      ? normalizeAssFontSize(extensionStyle.fontSize * resolution.height / ASS_REFERENCE_PLAY_RES_Y)
      : 0;
    const extensionAnimationTags = assMode && extensionStyle
      ? assAnimationOverrideTags(profile, { includeMove: false }) : '';
    if (assMode && extensionStyle) {
      extensionSource.forEach((segment) => {
        if (!segment || segment.disabled === true) return;
        const rawStart = normalizeAssTimeMs(mapTime(segment.start));
        const rawEnd = normalizeAssTimeMs(mapTime(segment.end));
        if (rawEnd <= rawStart) return;
        const startCentiseconds = Math.max(0, Math.round(rawStart / 10));
        const endCentiseconds = Math.max(startCentiseconds + 1, Math.round(rawEnd / 10));
        const extensionText = extensionAnimationTags
          ? `{${extensionAnimationTags}}${escapeAssText(segment.text)}` : escapeAssText(segment.text);
        events.push(
          `Dialogue: 1,${formatAssTime(startCentiseconds * 10)},${formatAssTime(endCentiseconds * 10)},Extension,,0,0,0,,${extensionText}`,
        );
      });
    }

    // 叠加轨事件：引用独立的 Overlay 样式（字段与主字幕样式完全一致，
    // 仅把 MarginV 固化为算好的锚定结果），事件行不再携带边距覆盖。颜色
    // 映射与主字幕一致（none 模式一起回落）；\fad/\fade/\t 逐句应用，
    // \move 的绝对坐标只属于主字幕。锚定公式固定为「下方最近一层字幕的
    // 垂直边距 + 1.2 × 该层字号」：有副字幕时叠在副字幕上方，否则叠在主
    // 字幕上方（1.2 倍在两层文字之间留出空档）。ASS 模式下各层边距来自
    // 样式库（用户可改），legacy 模式主字幕固定 80。
    const overlaySource = Array.isArray(options.overlaySegments) ? options.overlaySegments : [];
    const hasOverlayCues = overlaySource.some((segment) => segment && segment.disabled !== true);
    const overlayAnimationTags = assMode
      ? assAnimationOverrideTags(profile, { includeMove: false }) : '';
    const overlayMarginV = assMode
      ? (extensionStyle && hasExtensionCues
        ? Math.max(0, Number(extensionStyle.marginV) || 0) + Math.round(1.2 * extensionScaledFontSize)
        : Math.max(0, Number(baseStyle.marginV) || 0) + Math.round(1.2 * fontSize))
      : 80 + Math.round(1.2 * fontSize);
    // 链式锚定发生在哪一层的坐标系里，叠加样式就继承哪一层的对齐与水平
    // 边距：否则副字幕样式改成顶部/侧边对齐时，固化边距会按主样式的基准
    // 边解释，叠加轨落到画面另一侧。字体与颜色仍跟随主字幕样式。
    const overlayBaseStyle = assMode
      ? (extensionStyle && hasExtensionCues
        ? {
          ...baseStyle,
          alignment: extensionStyle.alignment,
          marginL: extensionStyle.marginL,
          marginR: extensionStyle.marginR,
        }
        : baseStyle)
      : {
        ...ASS_DEFAULT_ASS_STYLE,
        fontName: fontFamily,
        fontSize,
        primaryColor: appearance.color ?? options.color,
        outlineColor: '#000000',
        outline: 2,
        shadow: 0,
        alignment: 2,
        marginL: 10,
        marginR: 10,
      };
    const overlayStyleFor = (colorName) => {
      const variant = assColorGroupsSupported && ASS_COLOR_STYLE_NAMES.includes(colorName)
        ? assStyleVariant(overlayBaseStyle,
          colorStyles.find((item) => item.name === colorName)?.value || '#ffffff', colorStyle)
        : overlayBaseStyle;
      return { ...variant, marginV: overlayMarginV };
    };
    const overlayStyleNameFor = (colorName) => (
      assColorGroupsSupported && ASS_COLOR_STYLE_NAMES.includes(colorName)
        ? `Overlay ${colorName.toUpperCase()}` : 'Overlay'
    );
    overlaySource.forEach((segment) => {
      if (!segment || segment.disabled === true) return;
      const rawStart = normalizeAssTimeMs(mapTime(segment.start));
      const rawEnd = normalizeAssTimeMs(mapTime(segment.end));
      if (rawEnd <= rawStart) return;
      const startCentiseconds = Math.max(0, Math.round(rawStart / 10));
      const endCentiseconds = Math.max(startCentiseconds + 1, Math.round(rawEnd / 10));
      const overlayColorName = effectiveColorName(segment, overlaySource);
      const overlayText = overlayAnimationTags
        ? `{${overlayAnimationTags}}${escapeAssText(segment.text)}` : escapeAssText(segment.text);
      events.push(
        `Dialogue: 2,${formatAssTime(startCentiseconds * 10)},${formatAssTime(endCentiseconds * 10)},${overlayStyleNameFor(overlayColorName)},,0,0,0,,${overlayText}`,
      );
    });

    return [
      '[Script Info]',
      '; Script generated by MAW',
      `Title: ${title}`,
      'ScriptType: v4.00+',
      `PlayResX: ${resolution.width}`,
      `PlayResY: ${resolution.height}`,
      'WrapStyle: 0',
      'ScaledBorderAndShadow: yes',
      'YCbCr Matrix: None',
      '',
      '[V4+ Styles]',
      `Format: ${ASS_STYLE_FORMAT}`,
      ...(assMode
        ? [
          assStyleLine(baseStyle, 'Default', fontSize),
          ...(colorStyle === 'text' || colorStyle === 'stroke'
            ? colorStyles.map((color) => assStyleLine(
              assStyleVariant(baseStyle, color.value, colorStyle),
              color.name.toUpperCase(),
              fontSize,
            ))
            : []),
          // 副字幕：独立样式，边距/对齐/字号完全由该样式决定。
          ...(extensionStyle && hasExtensionCues
            ? [assStyleLine(extensionStyle, 'Extension', extensionScaledFontSize)]
            : []),
          // 叠加字幕：字段复用主字幕样式，MarginV 固化为链式锚定结果。
          ...(hasOverlayCues
            ? [
              assStyleLine(overlayStyleFor(null), 'Overlay', fontSize),
              ...(colorStyle === 'text' || colorStyle === 'stroke'
                ? colorStyles.map((color) => assStyleLine(
                  overlayStyleFor(color.name),
                  `Overlay ${color.name.toUpperCase()}`,
                  fontSize,
                ))
                : []),
            ]
            : []),
        ]
        : [
          `Style: Default,${fontFamily},${fontSize},${assColorFromHex(appearance.color ?? options.color)},${assColorFromHex(appearance.color ?? options.color)},&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,80,1`,
          ...(colorStyle === 'text'
            ? colorStyles.map((style) => (
              `Style: ${style.name.toUpperCase()},${fontFamily},${fontSize},${style.assValue},${style.assValue},&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,80,1`
            ))
            : colorStyle === 'stroke'
              ? colorStyles.map((style) => assStyleLine(
                assStyleVariant({
                  ...ASS_DEFAULT_ASS_STYLE,
                  fontName: fontFamily,
                  fontSize,
                  primaryColor: appearance.color ?? options.color,
                  outlineColor: '#000000',
                  outline: 2,
                  shadow: 0,
                  alignment: 2,
                  marginL: 10,
                  marginR: 10,
                  marginV: 80,
                }, style.value, colorStyle),
                style.name.toUpperCase(),
                fontSize,
              ))
              : []),
          // legacy 叠加样式：同样固化为算好的锚定边距（80 + 1.2 × 字号）。
          ...(hasOverlayCues
            ? [
              assStyleLine(overlayStyleFor(null), 'Overlay', fontSize),
              ...(colorStyle === 'text' || colorStyle === 'stroke'
                ? colorStyles.map((color) => assStyleLine(
                  overlayStyleFor(color.name),
                  `Overlay ${color.name.toUpperCase()}`,
                  fontSize,
                ))
                : []),
            ]
            : []),
        ]),
      '',
      '[Events]',
      `Format: ${ASS_EVENT_FORMAT}`,
      ...events,
      '',
    ].join('\n');
  }

  function buildPlainTextPayload(segments) {
    return (Array.isArray(segments) ? segments : [])
      .filter((segment) => segment && !segment.disabled)
      .map((segment) => String(segment.text || '').replace(/\r\n?/g, '\n'))
      .join('\n');
  }

  function fileBasename(value) {
    return String(value || '').trim().split(/[\\/]/).pop() || '';
  }

  const EXPORT_FRAME_PROFILES = Object.freeze({
    24: Object.freeze({ name: '24', numerator: 24, denominator: 1, fps: 24 }),
    25: Object.freeze({ name: '25', numerator: 25, denominator: 1, fps: 25 }),
    30: Object.freeze({ name: '30', numerator: 30, denominator: 1, fps: 30 }),
    '30000/1001': Object.freeze({ name: '30000/1001', numerator: 30000, denominator: 1001, fps: 30000 / 1001 }),
    50: Object.freeze({ name: '50', numerator: 50, denominator: 1, fps: 50 }),
    60: Object.freeze({ name: '60', numerator: 60, denominator: 1, fps: 60 }),
    '60000/1001': Object.freeze({ name: '60000/1001', numerator: 60000, denominator: 1001, fps: 60000 / 1001 }),
  });

  function resolveExportFrameProfile(fps, dropFrame = false) {
    if (typeof dropFrame !== 'boolean') throw new Error('drop-frame option must be boolean');
    const key = String(fps);
    const profile = EXPORT_FRAME_PROFILES[key];
    if (!profile) throw new Error(`unsupported export FPS: ${key}`);
    if (dropFrame) throw new Error(`drop-frame export is unsupported for ${key}`);
    return profile;
  }

  function exportMsToFrames(ms, fps, rounding = 'floor') {
    const profile = typeof fps === 'object' && fps?.numerator
      ? fps : resolveExportFrameProfile(fps, false);
    const value = Math.max(0, Number(ms)) * profile.numerator / (1000 * profile.denominator);
    if (!Number.isFinite(value)) throw new Error('invalid export time');
    if (rounding === 'ceil') return Math.max(1, Math.ceil(value));
    if (rounding !== 'floor') throw new Error(`unsupported frame rounding: ${rounding}`);
    return Math.max(0, Math.floor(value));
  }

  function mapExportTime(policy, sourceMs) {
    const source = Math.max(0, Math.round(Number(sourceMs) || 0));
    const mapped = policy.mode === 'source' ? source : mapGapRemovedTime(source, policy.gaps);
    return Math.min(policy.outputDurationMs ?? policy.sourceDurationMs, mapped);
  }

  function exportPolicyMsToFrames(policy, ms, rounding = 'floor') {
    return exportMsToFrames(ms, policy.profile, rounding);
  }

  const EXPORT_SUBTITLE_TRACKS = Object.freeze(['main', 'extension', 'overlay', 'both', 'main_and_extension', 'all']);
  const EXPORT_INVALID_NAME_CHARS = /[\\/<>:"|?*\u0000-\u001f]/g;
  const EXPORT_NAME_EXTENSIONS = new Set([
    '.mosp', '.json', '.srt', '.txt', '.ass', '.vtt', '.xml', '.ffconcat', '.otio', '.otioz',
    '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.ts', '.m4v',
    '.mp3', '.wav', '.m4a', '.flac', '.aac', '.ogg', '.opus',
  ]);
  const EXPORT_OPTION_KEYS = Object.freeze([
    'timelineMode', 'mode', 'fps', 'dropFrame', 'nativeTextObjects', 'subtitleTracks', 'baseName',
  ]);

  function normalizeExportOptions(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new Error('export options must be an object');
    }
    Object.keys(options).sort().forEach((key) => {
      if (!EXPORT_OPTION_KEYS.includes(key)) throw new Error(`unknown export option: ${key}`);
    });
    const timelineMode = options.timelineMode ?? options.mode ?? 'gap_removed';
    if (timelineMode !== 'source' && timelineMode !== 'gap_removed') {
      throw new Error(`unsupported export mode: ${timelineMode}`);
    }
    const fps = String(options.fps ?? 30);
    resolveExportFrameProfile(fps, options.dropFrame === true);
    if (options.dropFrame !== undefined && typeof options.dropFrame !== 'boolean') {
      throw new Error('drop-frame option must be boolean');
    }
    const subtitleTracks = options.subtitleTracks ?? 'main';
    if (!EXPORT_SUBTITLE_TRACKS.includes(subtitleTracks)) {
      throw new Error(`unsupported subtitle tracks: ${subtitleTracks}`);
    }
    const nativeTextObjects = options.nativeTextObjects ?? false;
    if (typeof nativeTextObjects !== 'boolean') throw new Error('native text option must be boolean');
    const dropFrame = options.dropFrame ?? false;
    const baseName = String(options.baseName ?? 'maw-export').trim();
    if (!baseName || baseName === '.' || baseName === '..' || /[\u0000-\u001f]/.test(baseName)) {
      throw new Error('invalid export base name');
    }
    return Object.freeze({
      timelineMode, fps, dropFrame, nativeTextObjects,
      subtitleTracks: subtitleTracks === 'both' ? 'main_and_extension' : subtitleTracks, baseName,
    });
  }

  function sanitizeExportName(value) {
    const source = String(value ?? '');
    const lastDot = source.lastIndexOf('.');
    const extension = lastDot >= 0 ? source.slice(lastDot).toLowerCase() : '';
    const name = EXPORT_NAME_EXTENSIONS.has(extension) ? source.slice(0, lastDot) : source;
    const sanitized = name
      .replace(/[\\/]+/g, '_')
      .replace(/^[.]+/, '_')
      .replace(/\.\.(?=_|$)/g, '_')
      .replace(EXPORT_INVALID_NAME_CHARS, '_')
      .replace(/[. ]+$/, '')
      .trim();
    if (!sanitized || sanitized === '.' || sanitized === '..') throw new Error('invalid export base name');
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(sanitized)) return `_${sanitized}_`;
    return sanitized;
  }

  function buildExportNames(baseName) {
    const safeBaseName = sanitizeExportName(baseName);
    return Object.freeze({
      baseName: safeBaseName,
      files: Object.freeze({
        project: `${safeBaseName}.xml`,
        subtitles: `${safeBaseName}.srt`,
      }),
    });
  }

  function escapeExportXml(value) {
    const text = String(value ?? '');
    for (const character of text) {
      const codePoint = character.codePointAt(0);
      if (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d) {
        throw new Error('XML 1.0 forbidden control character');
      }
    }
    return text.replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
    }[character]));
  }

  function exportPathToFileUrl(value, { encodeDriveColon = false } = {}) {
    const source = String(value ?? '').trim();
    if (!source) throw new Error('missing export path');
    if (/^file:\/\//i.test(source)) {
      const match = /^file:\/\/([^/]*)(\/.*)?$/i.exec(source);
      if (!match) throw new Error('invalid file URL');
      const authority = match[1];
      const pathValue = match[2] || '';
      const driveUrlMatch = /^\/([A-Za-z]):\/(.*)$/.exec(pathValue);
      if (authority.toLowerCase() === 'localhost' && driveUrlMatch) {
        const encodedPath = driveUrlMatch[2].split('/').map((part) => encodeURIComponent(part)).join('/');
        const drive = encodeDriveColon ? `${driveUrlMatch[1]}%3A` : `${driveUrlMatch[1]}:`;
        return `file://localhost/${drive}/${encodedPath}`;
      }
      if (!authority && driveUrlMatch) {
        const encodedDrivePath = driveUrlMatch[2].split('/').map((part) => encodeURIComponent(part)).join('/');
        return `file://localhost/${driveUrlMatch[1]}:/${encodedDrivePath}`;
      }
      if (authority && !pathValue || authority && !/^\/[^/]+(?:\/|$)/.test(pathValue)) {
        throw new Error('UNC file URL must include a share');
      }
      const encodedPath = pathValue.split('/').map((part) => encodeURIComponent(part)).join('/');
      return `file://${authority}${encodedPath}`;
    }
    const normalized = source.replace(/\\/g, '/');
    const uncMatch = /^\/\/([^/]+)(\/.*)?$/.exec(normalized);
    if (uncMatch) {
      const uncPath = uncMatch[2] || '';
      if (!/^\/[^/]+(?:\/|$)/.test(uncPath)) throw new Error('UNC path must include a share');
      const encodedUncPath = uncPath.split('/').map((part) => encodeURIComponent(part)).join('/');
      return `file://${uncMatch[1]}${encodedUncPath}`;
    }
    const driveMatch = /^([A-Za-z]):\/(.*)$/.exec(normalized);
    if (driveMatch) {
      const encodedDriveParts = driveMatch[2].split('/').map((part) => encodeURIComponent(part)).join('/');
      const drive = encodeDriveColon ? `${driveMatch[1]}%3A` : `${driveMatch[1]}:`;
      return `file://localhost/${drive}/${encodedDriveParts}`;
    }
    const withLeadingSlash = normalized;
    const rooted = withLeadingSlash.startsWith('/') ? withLeadingSlash : `/${withLeadingSlash}`;
    const encoded = rooted.split('/').map((part, index) => (
      index === 0 && part === '' ? '' : encodeURIComponent(part).replace(/^([A-Za-z])%3A$/, '$1:')
    )).join('/');
    return `file://${encoded}`;
  }

  function freezeExportValue(value, seen = new Set()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return value;
    seen.add(value);
    Object.values(value).forEach((child) => freezeExportValue(child, seen));
    return Object.freeze(value);
  }

  // schema §1.1：media_metadata.video_width / video_height 必须成对出现且为正整数。
  function exportVideoSize(project) {
    const width = Number(project?.media_metadata?.video_width);
    const height = Number(project?.media_metadata?.video_height);
    if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) return null;
    return { width, height };
  }

  function buildProjectExportPlan(project, options = {}) {
    if (!project || typeof project !== 'object') throw new Error('invalid export project');
    const media = project.media && typeof project.media === 'object' ? project.media : null;
    const mediaPath = String((typeof project.media === 'string' ? project.media : '')
      || media?.path || media?.mediaPath || '').trim();
    const durationValue = options.durationMs ?? project.waveform?.duration_ms ?? project.duration_ms
      ?? media?.durationMs ?? media?.duration_ms;
    const durationMs = durationValue;
    if (!mediaPath) throw new Error('missing export media path');
    if (!Number.isInteger(durationMs) || durationMs <= 0) throw new Error('missing export media duration');
    const requestedMode = options.timelineMode ?? options.mode ?? 'gap_removed';
    if (requestedMode !== 'source' && requestedMode !== 'gap_removed') {
      throw new Error(`unsupported export mode: ${requestedMode}`);
    }
    const mode = requestedMode;
    if (options.dropFrame !== undefined && typeof options.dropFrame !== 'boolean') {
      throw new Error('drop-frame option must be boolean');
    }
    const rawGaps = project.gaps !== undefined ? project.gaps : project.gap_remove?.gaps;
    if (rawGaps != null && !Array.isArray(rawGaps)) throw new Error('invalid export gaps');
    const malformedGap = (gap) => {
      const start = gap?.start;
      const end = gap?.end;
      return !Number.isInteger(start) || start < 0
        || !Number.isInteger(end) || end < 0 || end <= start;
    };
    if (Array.isArray(rawGaps) && rawGaps.some(malformedGap)) {
      throw new Error('invalid export gap interval');
    }
    const gaps = Array.isArray(rawGaps)
      ? rawGaps.map((gap) => ({
        start: Math.max(0, Math.round(Number(gap.start))),
        end: Math.max(0, Math.round(Number(gap.end))),
        removed: gap.removed !== false,
      }))
      : [];
    const keptIntervals = mode === 'source'
      ? [{ start: 0, end: durationMs }]
      : buildGapRemovedIntervals(durationMs, gaps);
    const outputDurationMs = keptIntervals.reduce((sum, interval) => sum + interval.end - interval.start, 0);
    if (outputDurationMs <= 0) throw new Error('export has no kept media');
    const frameProfile = resolveExportFrameProfile(options.fps ?? 30, options.dropFrame === true);
    const mapSourceToOutput = (sourceMs) => mode === 'source'
      ? Math.max(0, Math.min(durationMs, Math.round(Number(sourceMs) || 0)))
      : mapGapRemovedTime(sourceMs, gaps);
    const warnings = [];
    if (mode === 'gap_removed' && !gaps.some((gap) => gap.removed)) warnings.push({ code: 'no_removed_gaps' });
    const projectSegments = Array.isArray(project.segments) ? project.segments : [];
    // schema §1.5：叠加轨 enabled=false 时保留数据但不显示也不导出。
    const projectOverlaySegments = project.overlay_track?.enabled === true
      && Array.isArray(project.overlay_track.segments)
      ? project.overlay_track.segments : [];
    const schemaExtension = Array.isArray(project.multi_subtitle?.tracks)
      ? project.multi_subtitle.tracks.flatMap((track) => Array.isArray(track?.segments) ? track.segments : [])
      : [];
    const projectExtension = project.multi_subtitle?.enabled === true
      ? schemaExtension
      : (project.multi_subtitle == null && Array.isArray(project.extensionSegments)
        ? project.extensionSegments : []);
    const projectCues = (segments, track) => segments.map((segment, index) => {
      if (!segment || segment.disabled) return null;
      const rawStart = Math.round(Number(segment.start));
      const rawEnd = Math.round(Number(segment.end));
      const start = Math.min(durationMs, Math.max(0, rawStart));
      const end = Math.min(durationMs, Math.max(start, rawEnd));
      if (!Number.isInteger(segment?.start) || segment.start < 0
        || !Number.isInteger(segment?.end) || segment.end < 0 || segment.end <= segment.start) {
        warnings.push({ code: 'invalid_cue', track, index });
        return null;
      }
      const mappedStart = mapSourceToOutput(start);
      const mappedEnd = mapSourceToOutput(end);
      if (mappedEnd <= mappedStart) {
        warnings.push({ code: 'fully_removed_cue', track, index });
        return null;
      }
      if (rawStart !== start || rawEnd !== end) warnings.push({ code: 'clamped_cue_to_duration', track, index });
      return {
        id: String(segment.id || `${track}-${index}`), track, index,
        text: String(segment.text || ''), sourceStartMs: start, sourceEndMs: end,
        startMs: mappedStart, endMs: mappedEnd,
      };
    }).filter(Boolean);
    const cues = {
      main: projectCues(projectSegments, 'main'),
      extension: projectCues(projectExtension, 'extension'),
      overlay: projectCues(projectOverlaySegments, 'overlay'),
    };
    const stickers = [];
    const stickerHeads = new Set();
    const stickerRoot = String(project.sticker_root || project.stickerRoot || '').trim().replace(/[\\/]$/, '');
    const resolveStickerPath = (sticker) => {
      const rawPath = String(sticker?.rel || sticker?.filename || sticker?.path || sticker?.url || '').trim();
      if (!rawPath || !stickerRoot || /^[A-Za-z]:[\\/]/.test(rawPath)
        || rawPath.startsWith('/') || rawPath.startsWith('file://')) return rawPath;
      return `${stickerRoot}/${rawPath.replace(/^[\\/]+/, '')}`;
    };
    // 收集一条轨的表情包：ref 在所在轨数组内解析 head（叠加轨的 ref 只引用
    // 叠加轨自身段）。track 用于区分主轨 stickers 与叠加轨 overlayStickers。
    const collectStickers = (segments, track, output) => {
      const heads = new Set();
      segments.forEach((segment, index) => {
        const reference = segment?.sticker_ref;
        const source = segment?.sticker || (reference && segments[reference.headIdx]?.sticker);
        if (reference && Number.isInteger(reference.headIdx)) {
          const head = segments[reference.headIdx];
          if (!head?.sticker || head.disabled || reference.headIdx === index) {
            warnings.push({ code: 'dangling_sticker_reference', track, index, headIdx: reference.headIdx });
            return;
          } else {
            const headName = String(head.sticker.name || head.sticker.filename || '').replace(/\.[^.]+$/, '');
            if (reference.name && headName && reference.name !== headName) {
              warnings.push({ code: 'stale_sticker_reference', track, index, headIdx: reference.headIdx });
            }
          }
        }
        if (!source || segment.disabled || (segment.sticker && heads.has(index))) return;
        if (segment.sticker) heads.add(index);
        const timing = segment.sticker || segment;
        const stickerStart = Number(timing.start);
        const stickerEnd = Number(timing.end);
        const rawStart = Math.round(Number.isFinite(stickerStart) ? stickerStart : Number(segment.start) || 0);
        const rawEnd = Math.round(Number.isFinite(stickerEnd) ? stickerEnd : Number(segment.end) || 0);
        const start = Math.min(durationMs, Math.max(0, rawStart));
        const end = Math.min(durationMs, Math.max(start, rawEnd));
        if (end <= start || mapSourceToOutput(end) <= mapSourceToOutput(start)) {
          warnings.push({ code: 'fully_removed_sticker', track, index });
          return;
        }
        const resolvedStickerPath = resolveStickerPath(source);
        if (!resolvedStickerPath) {
          warnings.push({ code: 'missing_sticker_path', track, index });
          return;
        }
        if (rawStart !== start || rawEnd !== end) warnings.push({ code: 'clamped_sticker_to_duration', track, index });
        output.push({
          headIndex: index, track, name: String(source.name || ''),
          path: resolvedStickerPath, width: Number.isInteger(source.width) ? source.width : 720,
          height: Number.isInteger(source.height) ? source.height : 480,
          sourceStartMs: start, sourceEndMs: end,
          startMs: mapSourceToOutput(start), endMs: mapSourceToOutput(end),
        });
      });
    };
    collectStickers(projectSegments, 'main', stickers);
    const overlayStickers = [];
    collectStickers(projectOverlaySegments, 'overlay', overlayStickers);
    if (cues.main.length === 0 && cues.extension.length === 0 && cues.overlay.length === 0) {
      warnings.push({ code: 'no_enabled_cues' });
    }
    warnings.sort((left, right) => left.code.localeCompare(right.code) || (left.index ?? 0) - (right.index ?? 0));
    const plan = {
      media: {
        path: mediaPath,
        type: String(media?.type || 'video'),
        durationMs,
        // 源视频尺寸（schema §1.1 media_metadata），供 FCP7 序列 format 声明；
        // 旧工程缺失时为 null，序列 format 回退 1920x1080 而不是 DV NTSC 默认。
        width: exportVideoSize(project)?.width ?? null,
        height: exportVideoSize(project)?.height ?? null,
      },
      mode, sourceDurationMs: durationMs, keptIntervals, outputDurationMs,
      mapping: { mode, sourceDurationMs: durationMs, outputDurationMs, gaps },
      framePolicy: { profile: frameProfile, rounding: ['floor', 'ceil'], dropFrame: false },
      cues, stickers, overlayStickers, warnings, frameProfile,
      subtitleFontFamily: premiereFontFamily(project.preview?.subtitle?.font_family),
    };
    Object.defineProperties(plan, {
      mapSourceToOutput: { value: (sourceMs) => mapExportTime(plan.mapping, sourceMs), enumerable: false },
      frameForMs: { value: (ms, rounding = 'floor') => exportMsToFrames(ms, frameProfile, rounding), enumerable: false },
    });
    return freezeExportValue(plan);
  }

  function assertExportPlan(plan) {
    if (!plan || typeof plan !== 'object') throw new Error('invalid export plan');
    if (!plan.media || !String(plan.media.path || '').trim()) throw new Error('missing export media path');
    if (!Number.isInteger(plan.sourceDurationMs) || plan.sourceDurationMs <= 0) {
      throw new Error('missing export media duration');
    }
    if (!plan.frameProfile || !Number.isInteger(plan.frameProfile.numerator)
      || !Number.isInteger(plan.frameProfile.denominator)) {
      throw new Error('missing export frame profile');
    }
    if (!Number.isInteger(plan.outputDurationMs) || plan.outputDurationMs <= 0) {
      throw new Error('invalid export plan duration');
    }
    if (!Array.isArray(plan.keptIntervals) || !plan.keptIntervals.length
      || plan.keptIntervals.some((interval) => !Number.isInteger(interval?.start)
        || !Number.isInteger(interval?.end) || interval.end <= interval.start)) {
      throw new Error('empty export interval');
    }
    const outputDuration = plan.outputDurationMs;
    const cueLists = [plan.cues?.main, plan.cues?.extension, plan.cues?.overlay].filter(Array.isArray);
    if (cueLists.flat().some((cue) => cue.startMs < 0 || cue.endMs > outputDuration || cue.endMs <= cue.startMs)) {
      throw new Error('export cue outside output duration');
    }
    // 主轨与叠加轨的表情包导出计划共用同一条时间校验，非法计划不允许过校验关。
    const stickerLists = [plan.stickers, plan.overlayStickers].filter(Array.isArray);
    if (stickerLists.flat().some((sticker) => (
      sticker.startMs < 0 || sticker.endMs > outputDuration || sticker.endMs <= sticker.startMs
    ))) throw new Error('export sticker outside output duration');
    return plan;
  }

  function exportPlanFrame(plan, ms, rounding) {
    return exportMsToFrames(ms, plan.frameProfile, rounding);
  }

  function formatSrtTime(ms) {
    const value = Math.max(0, Math.round(Number(ms) || 0));
    const hours = Math.floor(value / 3600000);
    const minutes = Math.floor((value % 3600000) / 60000);
    const seconds = Math.floor((value % 60000) / 1000);
    const milliseconds = value % 1000;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(milliseconds).padStart(3, '0')}`;
  }

  function selectedSubtitleTracks(plan, subtitleTracks) {
    const selected = subtitleTracks === 'main_and_extension' || subtitleTracks === 'both'
      ? ['main', 'extension']
      : subtitleTracks === 'all'
        ? ['main', 'extension', 'overlay']
        : subtitleTracks === 'overlay'
          ? ['overlay']
          : subtitleTracks === 'extension' ? ['extension'] : ['main'];
    return selected.flatMap((track) => Array.isArray(plan.cues?.[track]) ? plan.cues[track] : []);
  }

  function serializeMappedSrt(plan, options = {}) {
    const exportPlan = assertExportPlan(plan);
    if (options.subtitleTracks !== undefined && !EXPORT_SUBTITLE_TRACKS.includes(options.subtitleTracks)) {
      throw new Error(`unsupported subtitle tracks: ${options.subtitleTracks}`);
    }
    const tracks = selectedSubtitleTracks(exportPlan, options.subtitleTracks || 'main');
    return `${tracks.map((cue, index) => {
      const start = Math.max(0, Math.round(Number(cue.startMs) || 0));
      const end = Math.max(start + 1, Math.round(Number(cue.endMs) || 0));
      return `${index + 1}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${String(cue.text || '')}\n`;
    }).join('\n')}`;
  }

  // FCP 7 XML 的 timebase 必须是整数帧率（29.97 → timebase 30 + ntsc TRUE）；
  // 写成 "30/1" 分数形式会被 Premiere 解析失败并回退到默认序列设置（DV NTSC）。
  function fcpTimebase(profile) {
    return profile.denominator === 1001 ? profile.numerator / 1000 : profile.numerator;
  }

  function fcpRate(profile) {
    return `<rate><timebase>${fcpTimebase(profile)}</timebase><ntsc>${profile.denominator === 1001 ? 'TRUE' : 'FALSE'}</ntsc></rate>`;
  }

  function fcpTimeRange(startMs, endMs, plan) {
    const start = exportPlanFrame(plan, startMs, 'floor');
    const end = Math.max(start + 1, exportPlanFrame(plan, endMs, 'ceil'));
    return { start, end, duration: end - start };
  }

  function encodeGraphicAndTypeText(text, fontFamily = 'FangSong', fontSize = FCP7_TEXT_FONT_SIZE_2160P) {
    const payload = {
      mTextParam: {
        // 段落对齐：实测 0=左对齐、1=右对齐、2=居中（PR 实机反馈校准）。
        mAlignment: 2,
        mBackFillColor: 0,
        mBackFillOpacity: 100,
        mBackFillSize: 0,
        mBackFillVisible: false,
        mDefaultRun: [],
        mHeight: 0,
        mHindiDigits: false,
        mIndic: false,
        mIsMask: false,
        mIsMaskInverted: false,
        mIsVerticalText: false,
        mLeading: 0,
        mLigatures: false,
        mLineCapType: 0,
        mLineJoinType: 0,
        mMiterLimit: 2.5,
        mNumStrokes: 1,
        mRTL: false,
        mShadowAngle: 0,
        mShadowBlur: 0,
        mShadowColor: 0,
        mShadowOffset: 0,
        mShadowOpacity: 0,
        mShadowSize: 0,
        mShadowVisible: false,
        mStyleSheet: {
          mAdditionalStrokeColor: [],
          mAdditionalStrokeVisible: [],
          mAdditionalStrokeWidth: [],
          mBaselineOption: { mParamValues: [[0, 0]] },
          mBaselineShift: { mParamValues: [[0, 0]] },
          mCapsOption: { mParamValues: [[0, 0]] },
          mFauxBold: { mParamValues: [[0, false]] },
          mFauxItalic: { mParamValues: [[0, false]] },
          mFillColor: { mParamValues: [[0, 16777215]] },
          mFillOverStroke: { mParamValues: [[0, true]] },
          mFillVisible: { mParamValues: [[0, true]] },
          mFontName: { mParamValues: [[0, fontFamily]] },
          mFontSize: { mParamValues: [[0, fontSize]] },
          mKerning: { mParamValues: [[0, 0]] },
          mStrokeColor: { mParamValues: [[0, 16777215]] },
          mStrokeVisible: { mParamValues: [[0, false]] },
          mStrokeWidth: { mParamValues: [[0, 1]] },
          mText: String(text ?? ''),
          mTracking: { mParamValues: [[0, 0]] },
          mTsumi: { mParamValues: [[0, 0]] },
          mUnderline: { mParamValues: [[0, false]] },
        },
        mTabWidth: 400,
        mWidth: 0,
      },
      mVersion: 1,
    };
    const json = JSON.stringify(payload);
    const bytes = new Uint8Array(8 + json.length * 2);
    bytes[0] = 0xf6;
    bytes[1] = 0x0a;
    for (let index = 0; index < json.length; index += 1) {
      const code = json.charCodeAt(index);
      bytes[8 + index * 2] = code & 0xff;
      bytes[9 + index * 2] = code >>> 8;
    }
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    if (typeof globalThis.btoa === 'function') return globalThis.btoa(binary);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let encoded = '';
    for (let index = 0; index < bytes.length; index += 3) {
      const first = bytes[index];
      const second = bytes[index + 1];
      const third = bytes[index + 2];
      encoded += alphabet[first >> 2];
      encoded += alphabet[((first & 3) << 4) | (second === undefined ? 0 : second >> 4)];
      encoded += second === undefined ? '=' : alphabet[((second & 15) << 2) | (third === undefined ? 0 : third >> 6)];
      encoded += third === undefined ? '=' : alphabet[third & 63];
    }
    return encoded;
  }

  function premiereFontFamily(value) {
    const key = String(value ?? '').trim();
    // 未选择字体（default）时不能给中文字幕配 Arial——按平台落到系统 CJK 字体，
    // 与 ASS 导出的默认字体策略一致；sans 预设的预览栈本身以 Arial 开头。
    return ({
      default: assDefaultFontFamily(),
      yahei: 'Microsoft YaHei',
      hei: 'SimHei',
      song: 'FangSong',
      sans: 'Arial',
    })[key] || key || assDefaultFontFamily();
  }

  // 原生文字默认位置：水平居中、偏下（相对帧宽高的归一化坐标，与 Premiere
  // 导出 XML 的 Position 参数格式一致；任何序列分辨率下表现一致）。
  const FCP7_TEXT_POSITION_X = 0.5;
  const FCP7_TEXT_POSITION_Y = 0.85;
  // 字号锚定 4K（2160p）序列的 120（用户实机确认的合适大小），按序列高度
  // 等比缩放以保持跨分辨率的视觉比例（1080p → 60）。
  const FCP7_TEXT_FONT_SIZE_2160P = 120;
  // Premiere 关键帧时间戳的“无限早”哨兵值，表示静态属性而非动画关键帧。
  const FCP7_TEXT_STATIC_KEYFRAME_TIME = '-91445760000000000';

  // GraphicAndType 的变换参数必须整套（2–22）书写：实测只写 Transform +
  // Position 的“半套”会让 Premiere 初始化出不可见的文字；完整结构逐字段
  // 对齐 Premiere 自己导出的 XML（Scale/Opacity 默认 100）。
  function fcp7TextMotionParameters() {
    const ts = FCP7_TEXT_STATIC_KEYFRAME_TIME;
    const parameter = (id, name, bounds, value) => `<parameter authoringApp="PremierePro"><parameterid>${id}</parameterid><name>${name}</name>${bounds}<value>${value}</value></parameter>`;
    const staticValue = (data) => `${ts},${data},0,0,0,0,0,0`;
    const pointValue = (x, y) => `${ts},${x}:${y},0,0,0,0,0,0,5,4,0,0,0,0`;
    const rangeBounds = (lower, upper) => `<LowerBound>${lower}</LowerBound><UpperBound>${upper}</UpperBound>`;
    const rotationBounds = '<ParameterControlType>3</ParameterControlType><LowerBound>-32768</LowerBound><UpperBound>32767</UpperBound>';
    return [
      parameter(2, 'Transform', '<ParameterControlType>11</ParameterControlType><UpperBound>false</UpperBound>', staticValue('false')),
      parameter(3, 'Position', '', pointValue(FCP7_TEXT_POSITION_X, FCP7_TEXT_POSITION_Y)),
      parameter(4, 'Scale', rangeBounds(0, 4000), staticValue('100.')),
      parameter(5, 'Horizontal Scale', rangeBounds(0, 4000), staticValue('100.')),
      parameter(6, ' ', '', staticValue('true')),
      parameter(7, 'Rotation', rotationBounds, staticValue('0.')),
      parameter(8, 'Opacity', rangeBounds(0, 100), staticValue('100.')),
      parameter(9, 'Anchor Point', '', pointValue(0, 0)),
      parameter(10, '', '<ParameterControlType>12</ParameterControlType><UpperBound>false</UpperBound>', staticValue('false')),
      parameter(11, ' ', rangeBounds(0, 32768), staticValue('0.')),
      parameter(12, ' ', rangeBounds(0, 32768), staticValue('0.')),
      parameter(13, 'start', rangeBounds(-100, 1000000000), staticValue('-1.')),
      parameter(14, 'end', rangeBounds(-100, 1000000000), staticValue('-1.')),
      parameter(15, ' ', '', staticValue('false')),
      parameter(16, ' ', '', staticValue('false')),
      parameter(17, ' ', '', staticValue('false')),
      parameter(18, ' ', '', staticValue('false')),
      parameter(19, 'Parent Width', rangeBounds(0, 20000), staticValue('0.')),
      parameter(20, 'Parent Height', rangeBounds(0, 20000), staticValue('0.')),
      parameter(21, 'Parent Rotation', rotationBounds, staticValue('0.')),
      parameter(22, ' ', '', staticValue('false')),
    ].join('');
  }

  // Graphic（含 GraphicAndType）剪辑必须带 Vector Motion（GraphicGroup）组：
  // 实测缺失时 Premiere 用异常锚点初始化（导入后不显示，或粘贴后文字从
  // Position 点向右下排布而不居中）；结构逐字段对齐 PR 导出的默认组。
  function fcp7TextGraphicGroupFilter() {
    const ts = FCP7_TEXT_STATIC_KEYFRAME_TIME;
    const parameter = (id, name, bounds, value) => `<parameter authoringApp="PremierePro"><parameterid>${id}</parameterid><name>${name}</name>${bounds}<value>${value}</value></parameter>`;
    const staticValue = (data) => `${ts},${data},0,0,0,0,0,0`;
    const pointValue = (x, y) => `${ts},${x}:${y},0,0,0,0,0,0,5,4,0,0,0,0`;
    const scaleBounds = '<LowerBound>0</LowerBound><UpperBound>10000</UpperBound><UpperUIBound>200</UpperUIBound>';
    const rotationBounds = '<ParameterControlType>3</ParameterControlType><LowerBound>-32768</LowerBound><UpperBound>32767</UpperBound>';
    const effect = `<effect><name>Vector Motion</name><effectid>GraphicGroup</effectid><effectcategory>graphic</effectcategory><effecttype>filter</effecttype><mediatype>video</mediatype><pproBypass>false</pproBypass>${parameter(1, 'Position', '', pointValue(0, 0))}${parameter(2, 'Scale', scaleBounds, staticValue('100.'))}${parameter(3, 'Scale Width', scaleBounds, staticValue('100.'))}${parameter(4, ' ', '', staticValue('true'))}${parameter(5, 'Rotation', rotationBounds, staticValue('0.'))}${parameter(6, 'Anchor Point', '', pointValue(0, 0))}</effect>`;
    return `<filter>${effect}</filter>`;
  }

  function fcpClipItem({ id, fileId, name, path, width, height, sourceStartMs, sourceEndMs, startMs, endMs, startFrame, endFrame, plan, mediaKind, track, link, defineFile = true, encodeDriveColon = false }) {
    const source = fcpTimeRange(sourceStartMs, sourceEndMs, plan);
    const timeline = fcpTimeRange(startMs, endMs, plan);
    const url = escapeExportXml(exportPathToFileUrl(path, { encodeDriveColon }));
    const isSticker = mediaKind === 'sticker';
    const media = mediaKind === 'audio' ? '<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex><channel>1</channel><channelcount>2</channelcount></sourcetrack>'
      : '<sourcetrack><mediatype>video</mediatype><trackindex>1</trackindex></sourcetrack>';
    const sourceDuration = exportPlanFrame(plan, plan.sourceDurationMs, 'ceil');
    const fileMedia = mediaKind === 'audio'
      ? `<media><audio><duration>${sourceDuration}</duration><channelcount>2</channelcount></audio></media>`
      : isSticker
        ? `<media><video><samplecharacteristics><rate><timebase>${plan.frameProfile.numerator}/${plan.frameProfile.denominator}</timebase><ntsc>${plan.frameProfile.denominator === 1001 ? 'TRUE' : 'FALSE'}</ntsc></rate><width>${Number.isInteger(width) && width > 0 ? width : 720}</width><height>${Number.isInteger(height) && height > 0 ? height : 480}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></video></media>`
        : `<media><video><duration>${sourceDuration}</duration></video><audio><duration>${sourceDuration}</duration><channelcount>2</channelcount></audio></media>`;
    const file = defineFile
      ? `<file id="${escapeExportXml(fileId)}"><name>${escapeExportXml(fileBasename(path))}</name><pathurl>${url}</pathurl><duration>${sourceDuration}</duration>${fcpRate(plan.frameProfile)}${isSticker ? `<timecode><rate>${fcpRate(plan.frameProfile).replace('<rate>', '').replace('</rate>', '')}</rate><string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>` : ''}${fileMedia}</file>`
      : `<file id="${escapeExportXml(fileId)}"/>`;
    const frameStart = startFrame ?? timeline.start;
    const frameEnd = Math.max(frameStart + 1, endFrame ?? frameStart + source.duration);
    const stickerClipMetadata = isSticker
      ? `<enabled>TRUE</enabled><alphatype>${/\.(?:gif|png|webp)$/iu.test(path) ? 'straight' : 'none'}</alphatype><pixelaspectratio>square</pixelaspectratio><anamorphic>FALSE</anamorphic>`
      : '';
    const masterClipMetadata = isSticker ? `<masterclipid>${escapeExportXml(fileId.replace(/^file-/, 'master-'))}</masterclipid>` : '';
    return `<clipitem id="${escapeExportXml(id)}">${masterClipMetadata}<name>${escapeExportXml(name)}</name>${stickerClipMetadata}<duration>${frameEnd - frameStart}</duration>${fcpRate(plan.frameProfile)}<start>${frameStart}</start><end>${frameEnd}</end><in>${source.start}</in><out>${source.end}</out>${file}${media}${link ? `<link><linkclipref>${escapeExportXml(link)}</linkclipref><mediatype>audio</mediatype><trackindex>1</trackindex><clipindex>1</clipindex></link>` : ''}<label>${escapeExportXml(track)}</label></clipitem>`;
  }

  function serializeFcp7Xml(plan, options = {}) {
    const exportPlan = assertExportPlan(plan);
    if (options.nativeTextObjects !== undefined && typeof options.nativeTextObjects !== 'boolean') {
      throw new Error('native text option must be boolean');
    }
    const nativeTextObjects = options.nativeTextObjects === true;
    const subtitleTracks = options.subtitleTracks || 'main';
    if (!EXPORT_SUBTITLE_TRACKS.includes(subtitleTracks)) {
      throw new Error(`unsupported subtitle tracks: ${subtitleTracks}`);
    }
    const mediaType = String(exportPlan.media.type || 'video').toLowerCase();
    const hasVideo = mediaType !== 'audio';
    // 序列级 format 告诉 Premiere 按媒体实际尺寸/帧率建序列；
    // 缺失时 Premiere 会回退到默认的 DV NTSC 720x480 序列设置。
    const sequenceWidth = Number.isInteger(exportPlan.media.width) && exportPlan.media.width > 0
      ? exportPlan.media.width : 1920;
    const sequenceHeight = Number.isInteger(exportPlan.media.height) && exportPlan.media.height > 0
      ? exportPlan.media.height : 1080;
    const videoFormat = `<format><samplecharacteristics>${fcpRate(exportPlan.frameProfile)}<width>${sequenceWidth}</width><height>${sequenceHeight}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance><colordepth>24</colordepth></samplecharacteristics></format>`;
    const audioFormat = '<format><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics></format>';
    let cursor = 0;
    const sourceTracks = [];
    const intervals = Array.isArray(exportPlan.keptIntervals) ? exportPlan.keptIntervals : [];
    const boundaries = [0];
    intervals.forEach((interval) => boundaries.push(boundaries[boundaries.length - 1]
      + fcpTimeRange(interval.start, interval.end, exportPlan).duration));
    const duration = boundaries[boundaries.length - 1];
    intervals.forEach((interval, index) => {
      const range = fcpTimeRange(interval.start, interval.end, exportPlan);
      const startMs = cursor * 1000 * exportPlan.frameProfile.denominator / exportPlan.frameProfile.numerator;
      const endMs = (cursor + range.duration) * 1000 * exportPlan.frameProfile.denominator / exportPlan.frameProfile.numerator;
      sourceTracks.push(fcpClipItem({
        id: `video-clip-${index + 1}`, fileId: 'file-source-video-1', name: `${fileBasename(exportPlan.media.path)} [${index + 1}]`,
        path: exportPlan.media.path, sourceStartMs: interval.start, sourceEndMs: interval.end,
        startMs, endMs, startFrame: boundaries[index], endFrame: boundaries[index + 1], plan: exportPlan, mediaKind: mediaType, track: 'source', defineFile: index === 0,
      }));
      cursor += range.duration;
    });
    const audioTracks = hasVideo ? intervals.map((interval, index) => {
      const range = fcpTimeRange(interval.start, interval.end, exportPlan);
      const startMs = (intervals.slice(0, index).reduce((sum, prior) => sum + fcpTimeRange(prior.start, prior.end, exportPlan).duration, 0)) * 1000 * exportPlan.frameProfile.denominator / exportPlan.frameProfile.numerator;
      const endMs = startMs + range.duration * 1000 * exportPlan.frameProfile.denominator / exportPlan.frameProfile.numerator;
      return fcpClipItem({ id: `audio-clip-${index + 1}`, fileId: 'file-source-audio', name: `${fileBasename(exportPlan.media.path)} audio [${index + 1}]`, path: exportPlan.media.path, sourceStartMs: interval.start, sourceEndMs: interval.end, startMs, endMs, startFrame: boundaries[index], endFrame: boundaries[index + 1], plan: exportPlan, mediaKind: 'audio', track: 'source-audio', link: `video-clip-${index + 1}`, defineFile: index === 0 });
    }) : [];
    const videoTracks = hasVideo ? [`<track>${sourceTracks.join('')}</track>`] : [];
    const stickerFileIds = new Map();
    const buildStickerTracks = (list, trackPrefix, clipPrefix) => (Array.isArray(list) ? list : [])
      .map((sticker, index) => {
        if (!String(sticker.path || '').trim()) return '';
        const stickerKey = `${trackPrefix}:${String(sticker.path)}`;
        const fileId = stickerFileIds.get(stickerKey) || `file-${trackPrefix}-${stickerFileIds.size + 1}`;
        const defineFile = !stickerFileIds.has(stickerKey);
        stickerFileIds.set(stickerKey, fileId);
        const clip = fcpClipItem({
          id: `${clipPrefix}-clip-${index + 1}`, fileId, name: `MAW sticker - ${sticker.name || index + 1}`,
          path: sticker.path, width: sticker.width, height: sticker.height, sourceStartMs: 0,
          sourceEndMs: Math.max(1, sticker.endMs - sticker.startMs),
          startMs: sticker.startMs, endMs: sticker.endMs, plan: exportPlan, mediaKind: 'sticker', track: `${trackPrefix}-${index + 1}`,
          defineFile, encodeDriveColon: true,
        });
        return `<track>${clip}</track>`;
      }).filter(Boolean);
    const stickerTracks = hasVideo
      ? buildStickerTracks(exportPlan.stickers, 'sticker', 'sticker')
        .concat(buildStickerTracks(exportPlan.overlayStickers, 'overlay-sticker', 'overlay-sticker'))
      : [];
    const textTracks = nativeTextObjects && hasVideo ? (subtitleTracks === 'main_and_extension' || subtitleTracks === 'both'
      ? ['main', 'extension']
      : subtitleTracks === 'all'
        ? ['main', 'extension', 'overlay']
        : subtitleTracks === 'overlay' ? ['overlay'] : subtitleTracks === 'extension' ? ['extension'] : ['main']).map((track) => {
      const cues = selectedSubtitleTracks(exportPlan, track);
      const generators = cues.map((cue, index) => {
        const range = fcpTimeRange(cue.startMs, cue.endMs, exportPlan);
        const text = encodeGraphicAndTypeText(cue.text, exportPlan.subtitleFontFamily,
          Math.round(FCP7_TEXT_FONT_SIZE_2160P * sequenceHeight / 2160));
        const clipId = `text-${track}-${index + 1}`;
        // clip / effect 名与 PR 原生 Graphic 一致使用字幕内容，时间线标签直接可读。
        // Transform(2)–Parent Rotation(21) 等变换参数按 Premiere 导出格式整套书写；
        // 只写 Position 时 Premiere 会初始化出不可见的文字。
        const motionParams = fcp7TextMotionParameters();
        // Graphic 画布尺寸必须与序列一致：缺失时 Premiere 按 DV NTSC 720x480
        // 分配画布，与序列不匹配导致文字不显示（粘贴重置后才能显示）。
        const textFileMedia = `<media><video><duration>${range.duration}</duration><samplecharacteristics>${fcpRate(exportPlan.frameProfile)}<width>${sequenceWidth}</width><height>${sequenceHeight}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></video></media>`;
        return `<clipitem id="${clipId}"><name>${escapeExportXml(cue.text)}</name><enabled>TRUE</enabled><duration>${range.duration}</duration>${fcpRate(exportPlan.frameProfile)}<start>${range.start}</start><end>${range.end}</end><in>0</in><out>${range.duration}</out><file id="file-${clipId}"><name>MAW GraphicAndType</name><mediaSource>GraphicAndType</mediaSource><duration>${range.duration}</duration>${fcpRate(exportPlan.frameProfile)}${textFileMedia}</file>${fcp7TextGraphicGroupFilter()}<filter><effect><name>${escapeExportXml(cue.text)}</name><effectid>GraphicAndType</effectid><effectcategory>graphic</effectcategory><effecttype>filter</effecttype><mediatype>video</mediatype><pproBypass>false</pproBypass><parameter authoringApp="MAW"><parameterid>1</parameterid><name>Source Text</name><value>${text}</value></parameter>${motionParams}</effect></filter></clipitem>`;
      }).join('');
      return generators ? `<track>${generators}</track>` : '';
    }).filter(Boolean) : [];
    const video = hasVideo ? `<video>${videoFormat}${videoTracks.concat(stickerTracks, textTracks).join('')}</video>` : '';
    const audio = mediaType === 'audio' ? `<audio>${audioFormat}<track>${sourceTracks.join('')}</track></audio>` : `<audio>${audioFormat}<track>${audioTracks.join('')}</track></audio>`;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="5"><sequence id="MAW-sequence"><name>MAW FCP 7 Premiere handoff</name><duration>${duration}</duration>${fcpRate(exportPlan.frameProfile)}<media>${video}${audio}</media></sequence></xmeml>`;
    return xml;
  }

  function buildFcp7ExportArtifacts(plan, options = {}) {
    const exportPlan = assertExportPlan(plan);
    const normalized = normalizeExportOptions({
      timelineMode: exportPlan.mode,
      fps: exportPlan.frameProfile.name,
      ...options,
    });
    if (normalized.timelineMode !== exportPlan.mode
      || normalized.fps !== exportPlan.frameProfile.name) {
      throw new Error('export artifact options do not match the shared plan');
    }
    const names = buildExportNames(normalized.baseName);
    const serializerOptions = {
      nativeTextObjects: normalized.nativeTextObjects,
      subtitleTracks: normalized.subtitleTracks,
    };
    return freezeExportValue([
      {
        kind: 'xml', filename: names.files.project, mime: 'application/xml',
        content: serializeFcp7Xml(exportPlan, serializerOptions), plan: exportPlan,
      },
      {
        kind: 'srt', filename: names.files.subtitles, mime: 'text/plain',
        content: serializeMappedSrt(exportPlan, serializerOptions), plan: exportPlan,
      },
    ]);
  }

  const EXPORT_SAVE_STATUSES = Object.freeze(['cancelled', 'failed', 'dispatched', 'saved']);

  async function saveSequentialExportArtifacts(artifacts, saveArtifact) {
    if (!Array.isArray(artifacts) || artifacts.length !== 2
      || artifacts[0]?.kind !== 'xml' || artifacts[1]?.kind !== 'srt') {
      throw new Error('export artifacts must contain XML then SRT');
    }
    if (typeof saveArtifact !== 'function') throw new Error('save artifact callback is required');
    const outcomes = { xml: 'not_attempted', srt: 'not_attempted', complete: false };
    for (const artifact of artifacts) {
      const result = await saveArtifact(artifact);
      const status = result?.status;
      if (!EXPORT_SAVE_STATUSES.includes(status)) throw new Error(`invalid export save status: ${status}`);
      outcomes[artifact.kind] = status;
      if (status === 'cancelled' || status === 'failed') return freezeExportValue(outcomes);
    }
    outcomes.complete = true;
    return freezeExportValue(outcomes);
  }

  function quoteFfconcatPath(value) {
    const normalized = String(value || '').trim().replace(/\\/g, '/');
    return `'${normalized.replace(/'/g, "'\\''")}'`;
  }

  function buildFfconcat(mediaPath, intervals) {
    const source = String(mediaPath || '').trim();
    if (!source) return '';
    const lines = ['ffconcat version 1.0'];
    (Array.isArray(intervals) ? intervals : []).forEach((interval) => {
      const start = Math.max(0, Math.round(Number(interval?.start) || 0));
      const end = Math.max(start, Math.round(Number(interval?.end) || 0));
      if (end <= start) return;
      lines.push(`file ${quoteFfconcatPath(source)}`);
      lines.push(`inpoint ${(start / 1000).toFixed(3)}`);
      lines.push(`outpoint ${(end / 1000).toFixed(3)}`);
    });
    return `${lines.join('\n')}\n`;
  }

  // macOS 上用 ⌘（event.metaKey）替代 Ctrl；Win/Linux 仍是 Ctrl。
  function isMacPlatform(nav) {
    const n = nav || globalThis.navigator;
    if (!n) return false;
    const p = String(n.platform || n.userAgentData?.platform || '');
    return /Mac|iPhone|iPad/.test(p);
  }

  function configuredEnterAction(event, splitKey) {
    if (event?.key !== 'Enter') return null;
    const mod = event.ctrlKey || event.metaKey;
    if (event.shiftKey && mod) return 'split';
    if (event.shiftKey) return 'newline';
    if (mod) return splitKey === 'ctrl-enter' ? 'split' : 'save';
    return splitKey === 'enter' ? 'split' : 'save';
  }

  // === 字幕预览几何（preview.subtitle）===
  // preview.subtitle 以 player-wrap 归一化分数存储 {x, y, width, height}。
  // 这些纯函数不触碰 DOM，可在 node:test 下直接验证。
  const PREVIEW_MIN_WIDTH = 0.20;
  const PREVIEW_MIN_HEIGHT = 0.08;
  const DEFAULT_PREVIEW_GEOMETRY = Object.freeze({
    x: 0.1, y: 0.76, width: 0.8, height: 0.16,
  });
  // 复刻原 CSS bottom:8% 的带状：y=0.76, height=0.16 → 76%→92%，留 8% 底边距；宽度默认 80% 居中。
  // 表情包预览的默认几何：右上角小图。
  const DEFAULT_STICKER_GEOMETRY = Object.freeze({
    x: 0.73, y: 0.04, width: 0.24, height: 0.3,
  });

  function clampNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  // 把任意输入归一化为合法 geometry；非法字段回退到指定默认值。
  function normalizePreviewGeometry(value, defaults = DEFAULT_PREVIEW_GEOMETRY) {
    if (!value || typeof value !== 'object') return { ...defaults };
    const geo = {
      x: clampNumber(value.x, defaults.x),
      y: clampNumber(value.y, defaults.y),
      width: clampNumber(value.width, defaults.width),
      height: clampNumber(value.height, defaults.height),
    };
    return clampPreviewGeometry(geo);
  }

  // 把 geometry 钳制到 [0,1] + min-size + 盒子不超出播放区。
  function clampPreviewGeometry(geo) {
    const width = Math.min(1, Math.max(PREVIEW_MIN_WIDTH, Number(geo.width) || 0));
    const height = Math.min(1, Math.max(PREVIEW_MIN_HEIGHT, Number(geo.height) || 0));
    const x = Math.min(1 - width, Math.max(0, Number(geo.x) || 0));
    const y = Math.min(1 - height, Math.max(0, Number(geo.y) || 0));
    return { x, y, width, height };
  }

  // geometry -> CSS 百分比样式（left/top/width/height）。
  function previewGeometryToCss(geo) {
    const clamped = clampPreviewGeometry(geo);
    return {
      left: `${(clamped.x * 100).toFixed(4)}%`,
      top: `${(clamped.y * 100).toFixed(4)}%`,
      width: `${(clamped.width * 100).toFixed(4)}%`,
      height: `${(clamped.height * 100).toFixed(4)}%`,
    };
  }

  // 根据手柄方向和归一化增量 (dx, dy) 计算新的 geometry。
  // handle: 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
  // 增量已是 player-wrap 归一化分数（调用方用 dx/wrapWidth 算好）。
  function applyPreviewGeometryDelta(geo, handle, dx, dy) {
    const clamped = clampPreviewGeometry(geo);
    const dxN = Number(dx) || 0;
    const dyN = Number(dy) || 0;
    if (handle === 'move') {
      return clampPreviewGeometry({
        x: clamped.x + dxN,
        y: clamped.y + dyN,
        width: clamped.width,
        height: clamped.height,
      });
    }
    // 以四条边计算，保证 min-size 后再钳制到播放区内。
    let left = clamped.x;
    let top = clamped.y;
    let right = clamped.x + clamped.width;
    let bottom = clamped.y + clamped.height;
    if (handle.includes('w')) left = clamped.x + dxN;
    if (handle.includes('e')) right = clamped.x + clamped.width + dxN;
    if (handle.includes('n')) top = clamped.y + dyN;
    if (handle.includes('s')) bottom = clamped.y + clamped.height + dyN;
    // min-size：若某边缩过最小值，以对边为锚回弹。
    if (right - left < PREVIEW_MIN_WIDTH) {
      if (handle.includes('w')) left = right - PREVIEW_MIN_WIDTH;
      else right = left + PREVIEW_MIN_WIDTH;
    }
    if (bottom - top < PREVIEW_MIN_HEIGHT) {
      if (handle.includes('n')) top = bottom - PREVIEW_MIN_HEIGHT;
      else bottom = top + PREVIEW_MIN_HEIGHT;
    }
    // 钳制到播放区 [0,1]。
    left = Math.max(0, left);
    top = Math.max(0, top);
    right = Math.min(1, right);
    bottom = Math.min(1, bottom);
    // 钳制后再保证 min-size（播放区不够大时优先贴边）。
    if (right - left < PREVIEW_MIN_WIDTH) right = Math.min(1, left + PREVIEW_MIN_WIDTH);
    if (bottom - top < PREVIEW_MIN_HEIGHT) bottom = Math.min(1, top + PREVIEW_MIN_HEIGHT);
    return clampPreviewGeometry({
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
    });
  }

  // === Lottie 动态字幕导出 ===
  // 生成器只负责无外部资源的 Lottie JSON；server-editor 再把它放进
  // dotLottie（.lottie）容器。这样时间码、字体、颜色和定位都能在 Node
  // 中单测，服务器不需要理解字幕工程的业务结构。
  const LOTTIE_DEFAULT_FPS = 30;
  const LOTTIE_DEFAULT_WIDTH = 1920;
  const LOTTIE_DEFAULT_HEIGHT = 1080;
  const LOTTIE_DEFAULT_FONT_FAMILY = 'Arial';
  const LOTTIE_DEFAULT_HIGHLIGHT_COLOR = '#ffd34d';
  const LOTTIE_FONT_FAMILY_ALIASES = Object.freeze({
    default: LOTTIE_DEFAULT_FONT_FAMILY,
    yahei: 'Microsoft YaHei',
    hei: 'SimHei',
    song: 'SimSun',
    sans: 'Arial',
  });

  function lottieAnimatedProperty(value) {
    return { a: 0, k: value };
  }

  function normalizeLottieFps(value) {
    const raw = String(value ?? '').trim();
    let fps = 0;
    if (/^\d+(?:\.\d+)?\/\d+(?:\.\d+)?$/u.test(raw)) {
      const [numerator, denominator] = raw.split('/').map(Number);
      fps = denominator > 0 ? numerator / denominator : 0;
    } else {
      fps = Number(raw);
    }
    return Number.isFinite(fps) && fps > 0 && fps <= 240 ? fps : LOTTIE_DEFAULT_FPS;
  }

  function normalizeLottieCanvasDimension(value, fallback) {
    const dimension = Math.round(Number(value));
    return Number.isFinite(dimension) && dimension >= 1 && dimension <= 16384
      ? dimension : fallback;
  }

  function lottieColor(value, fallback) {
    const source = typeof value === 'string' && /^#[0-9a-f]{6}$/iu.test(value)
      ? value : fallback;
    return [0, 2, 4].map((offset) => Number.parseInt(source.slice(1 + offset, 3 + offset), 16) / 255);
  }

  function normalizeLottieFontFamily(value) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw || raw === 'default') return LOTTIE_DEFAULT_FONT_FAMILY;
    return LOTTIE_FONT_FAMILY_ALIASES[raw] || raw;
  }

  function normalizeLottieRenderMode(value) {
    return value === 'glyph' ? 'glyph' : 'text';
  }

  function lottieTextUnits(value) {
    return Array.from(String(value || '').replace(/\r\n?/gu, '\n'));
  }

  function findLottieTextUnits(haystack, needle, fromIndex) {
    if (!needle.length) return -1;
    const start = Math.max(0, Math.min(haystack.length, Number(fromIndex) || 0));
    outer: for (let index = start; index <= haystack.length - needle.length; index++) {
      for (let offset = 0; offset < needle.length; offset++) {
        if (haystack[index + offset] !== needle[offset]) continue outer;
      }
      return index;
    }
    return -1;
  }

  function lottieSelectorKeyframes(entries, finalFrame, valueKey) {
    const byFrame = new Map();
    entries.forEach((entry) => {
      if (!Number.isFinite(entry.frame)) return;
      byFrame.set(Math.max(0, Math.round(entry.frame)), Math.max(0, Math.round(entry[valueKey])));
    });
    if (Number.isFinite(finalFrame)) byFrame.set(Math.max(0, Math.round(finalFrame)), 0);
    return [...byFrame.entries()].sort((left, right) => left[0] - right[0]).map(([frame, value]) => ({
      t: frame,
      s: [value],
      h: 1,
    }));
  }

  function buildLottieTextAnimator(
    segment, textUnits, cueStartFrame, cueEndFrame, fps, highlightColor,
  ) {
    const items = Array.isArray(segment?.items) ? segment.items : [];
    let ranges = [];
    let cursor = 0;
    items.forEach((item) => {
      const itemText = String(item?.text || '').replace(/\r\n?/gu, '\n');
      const itemUnits = lottieTextUnits(itemText);
      if (!itemUnits.length) return;
      const startIndex = findLottieTextUnits(textUnits, itemUnits, cursor);
      if (startIndex < 0) return;
      const endIndex = startIndex + itemUnits.length;
      const rawStart = Number(item?.start);
      const itemFrame = Number.isFinite(rawStart)
        ? Math.max(cueStartFrame, Math.min(cueEndFrame, Math.floor(rawStart / 1000 * fps)))
        : cueStartFrame;
      ranges.push({ frame: itemFrame, start: startIndex, end: endIndex });
      cursor = endIndex;
    });
    // SRT 和被文字处理过的工程可能没有可用的 items。仍然生成逐字高亮，
    // 将字符按句段时长均匀分配，避免导出的动态字幕退化为静态字幕。
    if (!ranges.length) {
      const frameSpan = Math.max(1, cueEndFrame - cueStartFrame);
      ranges = textUnits.map((_, index) => ({
        frame: cueStartFrame + Math.floor(frameSpan * index / textUnits.length),
        start: index,
        end: index + 1,
      }));
    }

    const first = ranges[0];
    const startEntries = [{ frame: cueStartFrame, start: first.frame > cueStartFrame ? 0 : first.start }];
    const endEntries = [{ frame: cueStartFrame, end: first.frame > cueStartFrame ? 0 : first.end }];
    ranges.slice(first.frame > cueStartFrame ? 0 : 1).forEach((range) => {
      startEntries.push({ frame: range.frame, start: range.start });
      endEntries.push({ frame: range.frame, end: range.end });
    });
    return {
      nm: 'MAW word highlight',
      s: {
        t: 0,
        xe: lottieAnimatedProperty(0),
        ne: lottieAnimatedProperty(0),
        a: lottieAnimatedProperty(100),
        b: 1,
        rn: 0,
        sh: 1,
        sm: lottieAnimatedProperty(100),
        o: lottieAnimatedProperty(0),
        r: 2,
        s: { a: 1, k: lottieSelectorKeyframes(startEntries, cueEndFrame, 'start') },
        e: { a: 1, k: lottieSelectorKeyframes(endEntries, cueEndFrame, 'end') },
      },
      a: {
        fc: lottieAnimatedProperty(highlightColor),
      },
    };
  }

  function buildLottieAnimation(segments, options = {}) {
    const width = normalizeLottieCanvasDimension(options.width, LOTTIE_DEFAULT_WIDTH);
    const height = normalizeLottieCanvasDimension(options.height, LOTTIE_DEFAULT_HEIGHT);
    const fps = normalizeLottieFps(options.fps);
    const source = Array.isArray(segments) ? segments : [];
    const maxSegmentEnd = source.reduce((max, segment) => {
      const end = Number(segment?.end);
      return Number.isFinite(end) ? Math.max(max, end) : max;
    }, 0);
    const requestedDuration = Number(options.durationMs);
    const durationMs = Math.max(
      maxSegmentEnd,
      Number.isFinite(requestedDuration) && requestedDuration > 0 ? requestedDuration : 0,
      1,
    );
    const totalFrames = Math.max(1, Math.ceil(durationMs / 1000 * fps));
    const subtitle = options.subtitle && typeof options.subtitle === 'object' ? options.subtitle : {};
    const geometry = normalizePreviewGeometry(subtitle, DEFAULT_PREVIEW_GEOMETRY);
    const boxWidth = Math.max(1, Math.round(geometry.width * width));
    const boxHeight = Math.max(1, Math.round(geometry.height * height));
    const centerX = Math.round((geometry.x + geometry.width / 2) * width);
    const centerY = Math.round((geometry.y + geometry.height / 2) * height);
    const referenceWidth = Number(options.previewReferenceWidth) > 0
      ? Number(options.previewReferenceWidth) : 960;
    const rawFontSize = Number(subtitle.font_size);
    const fontSize = Math.max(8, Math.min(512, Math.round(
      (Number.isFinite(rawFontSize) && rawFontSize > 0 ? rawFontSize : 18) * width / referenceWidth,
    )));
    const fontFamily = normalizeLottieFontFamily(subtitle.font_family);
    const renderMode = normalizeLottieRenderMode(options.renderMode);
    const baseColor = lottieColor(subtitle.color, '#ffffff');
    const highlightColor = lottieColor(options.highlightColor, LOTTIE_DEFAULT_HIGHLIGHT_COLOR);
    const layers = [];

    source.forEach((segment, index) => {
      if (!segment || segment.disabled) return;
      const text = String(segment.text || '').replace(/\r\n?/gu, '\n');
      const start = Number(segment.start);
      const end = Number(segment.end);
      if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
      const ip = Math.max(0, Math.min(totalFrames - 1, Math.floor(start / 1000 * fps)));
      const op = Math.max(ip + 1, Math.min(totalFrames, Math.ceil(end / 1000 * fps)));
      const textUnits = lottieTextUnits(text);
      const animator = buildLottieTextAnimator(
        segment, textUnits, ip, op, fps, highlightColor,
      );
      const document = {
        f: fontFamily,
        fc: baseColor,
        sc: [0, 0, 0],
        sw: 0,
        of: false,
        s: fontSize,
        lh: Math.round(fontSize * 1.25),
        sz: [boxWidth, boxHeight],
        ps: [-Math.round(boxWidth / 2), -Math.round(boxHeight / 2)],
        t: text.replace(/\n/gu, '\r'),
        j: 2,
        tr: 0,
        ls: 0,
      };
      layers.push({
        ddd: 0,
        ind: layers.length + 1,
        ty: 5,
        nm: `MAW 字幕 ${index + 1}`,
        sr: 1,
        ks: {
          o: lottieAnimatedProperty(100),
          r: lottieAnimatedProperty(0),
          p: lottieAnimatedProperty([centerX, centerY, 0]),
          a: lottieAnimatedProperty([0, 0, 0]),
          s: lottieAnimatedProperty([100, 100, 100]),
        },
        ao: 0,
        ip,
        op,
        st: 0,
        bm: 0,
        t: {
          d: { k: [{ s: document, t: 0 }] },
          a: animator ? [animator] : [],
          m: { a: lottieAnimatedProperty([0, 0]) },
          p: {},
        },
      });
    });

    return {
      v: '5.7.0',
      fr: fps,
      ip: 0,
      op: totalFrames,
      w: width,
      h: height,
      nm: 'MAW Dynamic Captions',
      ddd: 0,
      assets: [],
      fonts: { list: [{ fName: fontFamily, fFamily: fontFamily, fStyle: 'Regular', ascent: 75 }] },
      layers,
      meta: {
        g: 'moys-asr-workflow',
        d: 'MAW dynamic captions',
        renderMode,
        fontFamily,
        highlightColor: options.highlightColor || LOTTIE_DEFAULT_HIGHLIGHT_COLOR,
      },
    };
  }

  // === OGraf 动态字幕导出 ===
  // OGraf 不是一个只包含 JSON 的动画容器：规范要求 manifest（*.ograf.json）
  // 引用一个导出 Web Component 的 JavaScript 文件。这里生成无外部资源的
  // Canvas 组件，并由 server-editor 将 manifest 与 .mjs sidecar 一起打包。
  const OGRAF_SCHEMA_URL = 'https://ograf.ebu.io/v1/specification/json-schemas/graphics/schema.json';
  const OGRAF_DEFAULT_FONT_FAMILY = 'Arial';
  const OGRAF_DEFAULT_HIGHLIGHT_COLOR = '#ffd34d';
  const OGRAF_MANIFEST_FILENAME = 'maw-dynamic-captions.ograf.json';
  const OGRAF_MAIN_FILENAME = 'maw-dynamic-captions.mjs';

  function normalizeOgrafColor(value, fallback) {
    const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return /^#[0-9a-f]{6}$/u.test(raw) ? raw : fallback;
  }

  function normalizeOgrafFontFamily(value) {
    const base = normalizeLottieFontFamily(value || OGRAF_DEFAULT_FONT_FAMILY);
    const fallback = '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif';
    return /microsoft\s+yahei|pingfang|noto\s+sans\s+cjk/iu.test(base)
      ? base : `${base}, ${fallback}`;
  }

  function buildOgrafCueRanges(segment, textUnits) {
    const cueStart = Number(segment?.start);
    const cueEnd = Number(segment?.end);
    const items = Array.isArray(segment?.items) ? segment.items : [];
    const ranges = [];
    let cursor = 0;
    items.forEach((item) => {
      const itemText = String(item?.text || '').replace(/\r\n?/gu, '\n');
      const itemUnits = lottieTextUnits(itemText);
      if (!itemUnits.length) return;
      const startIndex = findLottieTextUnits(textUnits, itemUnits, cursor);
      if (startIndex < 0) return;
      const endIndex = startIndex + itemUnits.length;
      const rawStart = Number(item?.start);
      const rawEnd = Number(item?.end);
      const startMs = Number.isFinite(rawStart)
        ? Math.max(cueStart, Math.min(cueEnd, Math.round(rawStart))) : cueStart;
      const endMs = Number.isFinite(rawEnd)
        ? Math.max(startMs, Math.min(cueEnd, Math.round(rawEnd))) : cueEnd;
      if (endMs > startMs) ranges.push({ start: startIndex, end: endIndex, startMs, endMs });
      cursor = endIndex;
    });
    if (ranges.length) return ranges;

    // Imported SRT or edited cues may not have word timestamps. Keep the OGraf
    // output animated by distributing characters evenly over the cue duration.
    const span = Math.max(1, cueEnd - cueStart);
    return textUnits.map((_, index) => ({
      start: index,
      end: index + 1,
      startMs: cueStart + Math.floor(span * index / textUnits.length),
      endMs: cueStart + Math.max(
        1,
        Math.floor(span * (index + 1) / textUnits.length),
      ),
    })).map((range) => ({ ...range, endMs: Math.min(cueEnd, range.endMs) }));
  }

  function buildOgrafMainSource(data) {
    const embeddedData = JSON.stringify(data, null, 2);
    return String.raw`// Generated by moys-asr-workflow. Keep this file beside the .ograf.json manifest.
const DEFAULT_DATA = /*__maw_ograf_data__*/;

function clamp(value, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return minimum;
  return Math.max(minimum, Math.min(maximum, number));
}

function mergeState(base, patch) {
  const next = patch && typeof patch === 'object' ? patch : {};
  const merged = Object.assign({}, base || {}, next);
  merged.subtitle = Object.assign({}, base?.subtitle || {}, next.subtitle || {});
  if (!Array.isArray(next.cues) || !next.cues.length) merged.cues = base?.cues || [];
  return merged;
}

class MawDynamicCaptions extends HTMLElement {
  constructor() {
    super();
    this._data = DEFAULT_DATA;
    this._time = 0;
    this._playing = false;
    this._frame = 0;
    this._lastTimestamp = 0;
    this._schedule = [];
    this.attachShadow({ mode: 'open' });
    this._canvas = document.createElement('canvas');
    this._canvas.setAttribute('aria-hidden', 'true');
    this._canvas.style.display = 'block';
    this._canvas.style.width = '100%';
    this._canvas.style.height = '100%';
    this._canvas.style.background = 'transparent';
    this.shadowRoot.append(this._canvas);
    this._context = this._canvas.getContext('2d');
  }

  connectedCallback() {
    this.style.display = 'block';
    this.style.overflow = 'hidden';
    this.style.background = 'transparent';
    this._resize();
    this._draw();
  }

  async load({ data } = {}) {
    this._data = mergeState(DEFAULT_DATA, data);
    this._time = 0;
    this._resize();
    this._draw();
    return { statusCode: 200, statusMessage: 'OK' };
  }

  async dispose() {
    this._playing = false;
    this._stopLoop();
    this._schedule = [];
    return { statusCode: 200, statusMessage: 'OK' };
  }

  async playAction() {
    this._playing = true;
    if (this._time >= Number(this._data.durationMs || 0)) this._time = 0;
    this._lastTimestamp = 0;
    this._startLoop();
    return { statusCode: 200, statusMessage: 'OK', currentStep: 0 };
  }

  async stopAction() {
    this._playing = false;
    this._stopLoop();
    this._draw();
    return { statusCode: 200, statusMessage: 'OK' };
  }

  async updateAction({ data } = {}) {
    this._data = mergeState(this._data, data);
    this._resize();
    this._draw();
    return { statusCode: 200, statusMessage: 'OK' };
  }

  async customAction() {
    return { statusCode: 400, statusMessage: 'No custom actions supported' };
  }

  async goToTime({ timestamp } = {}) {
    this._time = clamp(timestamp, 0, Number(this._data.durationMs || 0));
    this._draw();
    return { statusCode: 200, statusMessage: 'OK' };
  }

  async setActionsSchedule({ schedule } = {}) {
    this._schedule = Array.isArray(schedule)
      ? schedule.filter((entry) => Number.isFinite(Number(entry?.timestamp)))
        .sort((left, right) => Number(left.timestamp) - Number(right.timestamp))
      : [];
    return { statusCode: 200, statusMessage: 'OK' };
  }

  _resize() {
    const width = Math.max(1, Math.round(Number(this._data.width) || 1920));
    const height = Math.max(1, Math.round(Number(this._data.height) || 1080));
    if (this._canvas.width !== width) this._canvas.width = width;
    if (this._canvas.height !== height) this._canvas.height = height;
  }

  _startLoop() {
    if (this._frame) return;
    const tick = (timestamp) => {
      this._frame = 0;
      if (!this._playing) return;
      const elapsed = this._lastTimestamp ? Math.max(0, timestamp - this._lastTimestamp) : 0;
      this._lastTimestamp = timestamp;
      const duration = Math.max(1, Number(this._data.durationMs) || 1);
      this._time = Math.min(duration, this._time + elapsed);
      this._draw();
      if (this._time >= duration) {
        this._playing = false;
        this._lastTimestamp = 0;
        return;
      }
      this._frame = requestAnimationFrame(tick);
    };
    this._frame = requestAnimationFrame(tick);
  }

  _stopLoop() {
    if (this._frame) cancelAnimationFrame(this._frame);
    this._frame = 0;
    this._lastTimestamp = 0;
  }

  _runScheduledActions() {
    while (this._schedule.length && Number(this._schedule[0].timestamp) <= this._time) {
      const entry = this._schedule.shift();
      const action = entry?.action || {};
      const params = action.params || {};
      if (action.type === 'updateAction') {
        this._data = mergeState(this._data, params.data);
        this._resize();
      } else if (action.type === 'playAction') {
        this._playing = true;
      } else if (action.type === 'stopAction') {
        this._playing = false;
      }
    }
  }

  _draw() {
    if (!this._context) return;
    this._runScheduledActions();
    const width = this._canvas.width;
    const height = this._canvas.height;
    this._context.clearRect(0, 0, width, height);
    const cues = Array.isArray(this._data.cues) ? this._data.cues : [];
    cues.filter((cue) => this._time >= Number(cue.startMs) && this._time < Number(cue.endMs))
      .forEach((cue) => this._drawCue(cue, width, height));
  }

  _drawCue(cue, width, height) {
    const subtitle = this._data.subtitle || {};
    const fontSize = Math.max(8, Number(subtitle.fontSize) || 18);
    const fontFamily = String(this._data.fontFamily || 'Arial, sans-serif');
    const lines = String(cue.text || '').replace(/\r\n?/g, '\n').split('\n');
    const context = this._context;
    const boxWidth = Math.max(1, Number(subtitle.width || 0.8) * width);
    const centerX = (Number(subtitle.x || 0.1) + Number(subtitle.width || 0.8) / 2) * width;
    const centerY = (Number(subtitle.y || 0.7) + Number(subtitle.height || 0.2) / 2) * height;
    context.textAlign = 'left';
    context.textBaseline = 'middle';
    context.font = fontSize + 'px ' + fontFamily;
    const lineUnits = lines.map((line) => Array.from(line));
    const longestLine = lineUnits.reduce((longest, units) => Math.max(
      longest,
      units.reduce((total, character) => total + context.measureText(character).width, 0),
    ), 0);
    const actualFontSize = longestLine > boxWidth
      ? Math.max(8, fontSize * boxWidth / longestLine) : fontSize;
    context.font = actualFontSize + 'px ' + fontFamily;
    const lineHeight = actualFontSize * 1.25;
    const firstBaseline = centerY - (lines.length - 1) * lineHeight / 2;
    let globalIndex = 0;
    lineUnits.forEach((units, lineIndex) => {
      const widths = units.map((character) => context.measureText(character).width);
      const lineWidth = widths.reduce((total, value) => total + value, 0);
      let cursorX = centerX - lineWidth / 2;
      const baseline = firstBaseline + lineIndex * lineHeight;
      units.forEach((character, characterIndex) => {
        const rangeIndex = globalIndex + characterIndex;
        context.fillStyle = String(subtitle.color || '#ffffff');
        context.fillText(character, cursorX, baseline);
        const highlighted = (Array.isArray(cue.ranges) ? cue.ranges : []).some((range) => (
          rangeIndex >= Number(range.start)
          && rangeIndex < Number(range.end)
          && this._time >= Number(range.startMs)
          && this._time < Number(range.endMs)
        ));
        if (highlighted) {
          context.fillStyle = String(subtitle.highlightColor || '#ffd34d');
          context.fillText(character, cursorX, baseline);
        }
        cursorX += widths[characterIndex];
      });
      globalIndex += units.length + (lineIndex < lineUnits.length - 1 ? 1 : 0);
    });
  }
}

if (!customElements.get('maw-dynamic-captions')) {
  customElements.define('maw-dynamic-captions', MawDynamicCaptions);
}

export default MawDynamicCaptions;
`.replace('/*__maw_ograf_data__*/', embeddedData);
  }

  function buildOgrafGraphic(segments, options = {}) {
    const width = normalizeLottieCanvasDimension(options.width, LOTTIE_DEFAULT_WIDTH);
    const height = normalizeLottieCanvasDimension(options.height, LOTTIE_DEFAULT_HEIGHT);
    const fps = normalizeLottieFps(options.fps);
    const source = Array.isArray(segments) ? segments : [];
    const maxSegmentEnd = source.reduce((max, segment) => {
      const end = Number(segment?.end);
      return Number.isFinite(end) ? Math.max(max, end) : max;
    }, 0);
    const requestedDuration = Number(options.durationMs);
    const durationMs = Math.max(
      maxSegmentEnd,
      Number.isFinite(requestedDuration) && requestedDuration > 0 ? requestedDuration : 0,
      1,
    );
    const subtitle = options.subtitle && typeof options.subtitle === 'object' ? options.subtitle : {};
    const geometry = normalizePreviewGeometry(subtitle, DEFAULT_PREVIEW_GEOMETRY);
    const referenceWidth = Number(options.previewReferenceWidth) > 0
      ? Number(options.previewReferenceWidth) : 960;
    const rawFontSize = Number(subtitle.font_size);
    const fontSize = Math.max(8, Math.min(512, Math.round(
      (Number.isFinite(rawFontSize) && rawFontSize > 0 ? rawFontSize : 18) * width / referenceWidth,
    )));
    const data = {
      version: '1.0.0',
      width,
      height,
      fps,
      durationMs: Math.round(durationMs),
      fontFamily: normalizeOgrafFontFamily(subtitle.font_family || OGRAF_DEFAULT_FONT_FAMILY),
      subtitle: {
        x: geometry.x,
        y: geometry.y,
        width: geometry.width,
        height: geometry.height,
        fontSize,
        color: normalizeOgrafColor(subtitle.color, '#ffffff'),
        highlightColor: normalizeOgrafColor(options.highlightColor, OGRAF_DEFAULT_HIGHLIGHT_COLOR),
      },
      cues: [],
    };

    source.forEach((segment, index) => {
      if (!segment || segment.disabled) return;
      const text = String(segment.text || '').replace(/\r\n?/gu, '\n');
      const start = Number(segment.start);
      const end = Number(segment.end);
      if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
      const textUnits = lottieTextUnits(text);
      data.cues.push({
        id: `cue-${index + 1}`,
        startMs: Math.round(start),
        endMs: Math.round(end),
        text,
        ranges: buildOgrafCueRanges(segment, textUnits),
      });
    });

    return {
      manifestFilename: OGRAF_MANIFEST_FILENAME,
      mainFilename: OGRAF_MAIN_FILENAME,
      manifest: {
        $schema: OGRAF_SCHEMA_URL,
        id: 'maw-dynamic-captions',
        version: '1.0.0',
        name: 'MAW Dynamic Captions',
        description: 'Dynamic subtitle captions rendered by a Canvas Web Component.',
        author: { name: 'moys-asr-workflow' },
        main: OGRAF_MAIN_FILENAME,
        schema: {
          type: 'object',
          required: ['width', 'height', 'fps', 'durationMs', 'subtitle', 'cues'],
          properties: {
            version: { type: 'string' },
            width: { type: 'number', minimum: 1 },
            height: { type: 'number', minimum: 1 },
            fps: { type: 'number', exclusiveMinimum: 0 },
            durationMs: { type: 'integer', minimum: 1 },
            fontFamily: { type: 'string' },
            subtitle: { type: 'object' },
            cues: { type: 'array' },
          },
        },
        supportsRealTime: true,
        supportsNonRealTime: true,
        stepCount: 1,
      },
      mainSource: buildOgrafMainSource(data),
    };
  }

  // 统一撤销/重做栈：管理两个不透明记录数组。
  // - push(record)：压入 undo 栈，清空 redo 栈，按 limit 裁剪。
  // - popUndo(currentSnapshot)：从 undo 弹出一条记录，把当前快照压入 redo，
  //   返回被弹出的记录供调用方应用。空栈返回 null。
  // - popRedo(currentSnapshot)：对称地从 redo 弹出，把当前快照压入 undo。
  // 调用方负责按记录的 kind 生成 currentSnapshot 与应用记录。
  function createHistoryStack(limit = 100) {
    const max = Math.max(1, Math.round(Number(limit) || 100));
    const undo = [];
    const redo = [];
    const trim = () => { while (undo.length > max) undo.shift(); };
    return {
      undoLength: () => undo.length,
      redoLength: () => redo.length,
      canUndo: () => undo.length > 0,
      canRedo: () => redo.length > 0,
      peekUndo: () => undo[undo.length - 1] || null,
      peekRedo: () => redo[redo.length - 1] || null,
      push: (record) => {
        undo.push(record);
        trim();
        redo.length = 0;
      },
      popUndo: (currentSnapshot) => {
        if (!undo.length) return null;
        const record = undo.pop();
        redo.push(currentSnapshot);
        return record;
      },
      popRedo: (currentSnapshot) => {
        if (!redo.length) return null;
        const record = redo.pop();
        undo.push(currentSnapshot);
        trim();
        return record;
      },
      clear: () => { undo.length = 0; redo.length = 0; },
      clearRedo: () => { redo.length = 0; },
    };
  }

  window.AsrEditorUtils = {
    PROJECT_SCHEMA,
    supportsProjectSchema,
    subtitleFontFamilyDisplayName,
  SUBTITLE_FONT_FAMILY_PRESETS,
  subtitleFontFamilyStoredToInput,
  subtitleFontFamilyInputToStored,
  mergeFontFamilyOptions,
  filterFontFamilyOptions,
    SPEAKER_LABEL_COLORS,
    DEFAULT_SPEAKER_LABELS,
    SPEAKER_LABEL_MAX_LENGTH,
    DEFAULT_SPEAKER_LABEL_SEPARATOR,
    SPEAKER_LABEL_SEPARATOR_MAX_LENGTH,
    normalizeSpeakerLabel,
    normalizeSpeakerLabels,
    normalizeSpeakerLabelSeparator,
    normalizeSpeakerLabelSettings,
    speakerLabelForSegment,
    formatSpeakerLabelledText,
    decodeSubtitleText,
    parseBwfTimeReference,
    readBwfTimeReferenceFromFile,
    normalizeKeyboardOperationReferenceMode,
    resolveKeyboardOperationReference,
    buildReplacementPreview,
    applyTextProcessing,
    buildTextProcessingPreview,
    buildTimedTextDiff,
    timedTextItemCoverage,
    timedTextItemReuse,
    buildTimedTextBoundaryPlan,
    buildTimedTextStructurePlan,
    buildTimedTextEditReport,
    timedTextEditDirtyFlags,
    applyTimedTextEdit,
    countTextUnits,
    countSubtitleUnits,
    cueMetrics,
    joinSegmentTexts,
    subtitleTextLength,
    isShortSubtitleText,
    normalizeSegmentTimings,
    normalizeItemTimingRanges,
    normalizeFrameItemTimingRanges,
    repairSegmentOverlap,
    planAutoMerge,
    applyAutoMergeSnaps,
    planSubtitleExtension,
    applySubtitleExtension,
    formatHumanDuration,
    formatGapRemoveDuration,
    splitCharOffsetAtTime,
    alignItemsToText,
    placeUnalignedSplitItems,
    splitAlignmentDriftMs,
    findAdjacentCueIndex,
    findCueNavigationTarget,
    findCueSelectionExtensionTarget,
    resolveMergedGroupInheritance,
    MULTI_SUBTITLE_SCHEMA,
    MULTI_SUBTITLE_TOLERANCE_MS,
    MULTI_SUBTITLE_DISPLAY_MODES,
    MULTI_SUBTITLE_SPLIT_MODES,
    ensureStableSegmentIds,
    uniqueStableSegmentId,
    normalizeMultiSubtitle,
    normalizeMultiSubtitleProject,
    normalizeOverlayTrack,
    mergeMainAndOverlaySegments,
    moveSegmentBetweenTracks,
    detectSubtitleSplitMode,
    isWordSplitConnector,
    SPLIT_TRIM_PRIMARY_SYMBOLS,
    DEFAULT_EXTRA_SPLIT_TRIM_SYMBOLS,
    DEFAULT_SPLIT_TRIM_SYMBOLS,
    parseSplitTrimSymbolInput,
    normalizeSplitTrimSymbols,
    setSplitTrimSymbols,
    applySplitEdgeTrim,
    subtitleSplitOffsets,
    cleanSplitTextParts,
    splitSubtitleText,
    nearestSubtitleSplitOffset,
    hasUsableSplitTimestamps,
    bindingForSegment,
    buildSubtitleBinding,
    rebuildBindingOffsets,
    swapMainAndExtensionSubtitle,
    removeSubtitleBindings,
    matchSubtitleSegments,
    buildMultiDisplayRows,
    getSrtExportFirstIndex,
    getSrtExportOffset,
    EDITOR_ACCENT_COLOR_VALUES,
    DEFAULT_EDITOR_ACCENT_CUSTOM_COLOR,
    EDITOR_SUBTITLE_COLOR_NAMES,
    DEFAULT_EDITOR_SUBTITLE_COLOR_PALETTE,
    normalizeSubtitleColorPalette,
    normalizeEditorAccentColor,
    normalizeEditorAccentCustomColor,
    normalizeEditorSettings,
    TIMELINE_TIMEBASE_UNITS,
    DEFAULT_TIMELINE_FPS,
    DEFAULT_TIMELINE_TIMECODE_SEPARATOR,
    MIN_TIMELINE_FPS,
    MAX_TIMELINE_FPS,
    normalizeTimelineFps,
    normalizeTimelineTimecodeSeparator,
    normalizeTimelineTimebase,
    normalizeMediaMetadata,
    frameNumberFromMilliseconds,
    millisecondsFromFrameNumber,
    formatFrameTimecode,
    formatTimelineTimecode,
    parseFrameTimecode,
    clampTimelineFrameStep,
    normalizeMultiSubtitleRowHeight,
    normalizeClickBehavior,
    normalizeClickTarget,
    normalizeKeyboardOperationReferenceMode,
    normalizeJklPlaybackMode,
    clampMediaSeekStepMs,
    clampCueMoveStepMs,
    clampAutoSaveInterval,
    clampCharcountThreshold,
    clampNinjaSlashLength,
    clampNinjaSlashRotateAmplitude,
    clampAutoMergeGapMs,
    clampAutoMergeShortCount,
    GAP_REMOVE_DISABLE_COVERAGE_DEFAULT,
    GAP_REMOVE_DISABLE_REMAINING_DEFAULT_MS,
    GAP_REMOVE_DISABLE_REMAINING_MAX_MS,
    clampGapRemoveDisableCoverage,
    clampGapRemoveDisableRemaining,
    normalizeGapRemoveData,
    normalizeGapRemoveProvenance,
    gapRangesFromProvenance,
    decorateGapRemoveGaps,
    getGapRemoveDisplayType,
    isGapRemoveDisplayProtected,
    removeGapRemoveProvenanceRange,
    getGapRemoveDisplayGaps,
    replaceGapRemoveProvenanceSource,
    appendGapRemoveManualOverrides,
    buildSegmentsHistorySnapshot,
    buildHistoryRecord,
    effectiveColorName,
    shiftGroupReferenceIndices,
    repairGroupReferenceIndices,
    shiftSelectionAfterRemoval,
    buildSrtPayload,
    normalizeAssFontFamily,
    normalizeAssFontSize,
    resolveAssFontSize,
    ASS_REFERENCE_PLAY_RES_Y,
    normalizeAssPlayResolution,
    normalizeAssHeaderValue,
    ASS_COLOR_STYLE_NAMES,
    assColorFromHex,
    formatAssTime,
    escapeAssText,
    ASS_STYLE_LIBRARY_SCHEMA,
    ASS_DEFAULT_STYLE,
    ASS_DEFAULT_ASS_STYLE,
    ASS_DEFAULT_EXTENSION_STYLE,
    ASS_DEFAULT_ANIMATIONS,
    ASS_DEFAULT_PROFILE,
    normalizeAssStyle,
    normalizeAssAnimations,
    normalizeAssProfile,
    defaultAssStyleLibrary,
    normalizeAssStyleLibrary,
    assStyleForId,
    assProfileForId,
    assStyleVariant,
    assStyleLine,
    assAnimationOverrideTags,
    assTransformStyleTargets,
    assPreviewStyleAt,
    assPreviewAnimationState,
    buildAssPayload,
    buildPlainTextPayload,
    fileBasename,
    normalizeGapRemoveGaps,
    applyGapRemoveRange,
    shrinkGapRemoveGaps,
    moveGapRemoveRange,
    copyGapRemoveRange,
    moveGapRemoveProvenance,
    resizeGapRemoveBoundary,
    detectAudioGapRemoveGaps,
    getRemovedGapRanges,
    findGapRemoveDisableMatches,
    mapGapRemovedTime,
    buildGapRemovedIntervals,
    buildGapRemovedDynamicSegments,
    resolveGapFillRange,
    EXPORT_FRAME_PROFILES,
    resolveExportFrameProfile,
    exportMsToFrames,
    mapExportTime,
    exportPolicyMsToFrames,
    normalizeExportOptions,
    sanitizeExportName,
    buildExportNames,
    escapeExportXml,
    exportPathToFileUrl,
    buildProjectExportPlan,
    exportVideoSize,
    serializeMappedSrt,
    serializeFcp7Xml,
    buildFcp7ExportArtifacts,
    saveSequentialExportArtifacts,
    buildFfconcat,
    configuredEnterAction,
    isMacPlatform,
    createHistoryStack,
    PREVIEW_MIN_WIDTH,
    PREVIEW_MIN_HEIGHT,
  DEFAULT_PREVIEW_GEOMETRY,
  DEFAULT_STICKER_GEOMETRY,
  normalizePreviewGeometry,
    clampPreviewGeometry,
    previewGeometryToCss,
    applyPreviewGeometryDelta,
    buildLottieAnimation,
    buildOgrafGraphic,
  };
  if (window.MAWE?.register) {
    window.MAWE.register('editor-utils', () => window.AsrEditorUtils);
  }
})();
