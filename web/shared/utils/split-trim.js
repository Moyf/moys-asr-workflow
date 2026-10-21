// split-trim: private helpers; dependencies are injected by editor-utils.js.
export function createUtilsModule(dependencies) {
  'use strict';

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


  // 拆分边缘修剪穿透 MASS 符号壳（账本 #19③）：修剪边缘是成对符号时，符号
  // 视为透明，继续修剪其内侧的空白，可叠多层壳（>>!! 文字!!<< → >>!!文字!!<<）。
  // 保守约束：只剥空白、绝不动符号本身；壳内正文会被剥空时不剥（空壳保留）。
  // 与拆分补齐的执行顺序维持既有安排：本修剪发生在 splitSubtitleText /
  // cleanSplitTextParts 内部（补齐之前），修剪集本就不含 MASS 符号。
  const MASS_SHELL_CHARACTERS = new Set(['*', '+', '-', '_', '~', '!', '/', '%', '>', '<']);

  const MASS_SHELL_MAX_RUN = 8;

  function shellRunLengthAtEdge(text, edge) {
    let length = 0;
    while (length < text.length && length < MASS_SHELL_MAX_RUN) {
      const character = edge === 'start' ? text[length] : text[text.length - 1 - length];
      if (!MASS_SHELL_CHARACTERS.has(character)) break;
      length += 1;
    }
    return length;
  }

  // 完整符号壳检测：两端是同符号对（!! ** ++ -- __ ~~ //）或句级 fade 对
  // （>>…<< / >…<），且壳内有非空白正文。返回两侧符号串长度，否则 null。
  function completeMassShellBounds(text) {
    const openLength = shellRunLengthAtEdge(text, 'start');
    const closeLength = shellRunLengthAtEdge(text, 'end');
    if (!openLength || !closeLength || openLength + closeLength >= text.length) return null;
    const open = text.slice(0, openLength);
    const close = text.slice(text.length - closeLength);
    const body = text.slice(openLength, text.length - closeLength);
    if (!body.trim()) return null;
    const sameSymbol = open[0] !== '>' && open[0] !== '<' && open[0] === close[close.length - 1];
    const fadePair = (open === '>>' && close === '<<') || (open === '>' && close === '<');
    return sameSymbol || fadePair ? { openLength, closeLength } : null;
  }

  function stripWhitespaceInsideMassShells(text, edge) {
    let current = String(text || '');
    // 1) 修剪边缘逐层穿透符号壳，剥掉符号内侧紧邻的空白。
    for (let guard = 0; guard < MASS_SHELL_MAX_RUN; guard += 1) {
      const runLength = shellRunLengthAtEdge(current, edge);
      if (!runLength) break;
      const stripped = edge === 'start'
        ? current.slice(0, runLength) + current.slice(runLength).replace(/^\s+/u, '')
        : current.slice(0, current.length - runLength).replace(/\s+$/u, '')
          + current.slice(current.length - runLength);
      if (stripped === current) break;
      current = stripped;
    }
    // 2) 壳贴边时剥壳内两侧贴边空白，递归处理嵌套壳；正文被剥空则保守停止。
    for (let guard = 0; guard < MASS_SHELL_MAX_RUN; guard += 1) {
      const shell = completeMassShellBounds(current);
      if (!shell) break;
      const body = current.slice(shell.openLength, current.length - shell.closeLength);
      const trimmedBody = stripWhitespaceInsideMassShells(body, edge);
      if (!trimmedBody || trimmedBody === body) break;
      current = current.slice(0, shell.openLength) + trimmedBody
        + current.slice(current.length - shell.closeLength);
    }
    return current;
  }

  function applySplitEdgeTrim(value, edge = 'end') {
    const text = String(value || '');
    const trimmed = edge === 'start'
      ? text.replace(activeStartTrimPattern, '')
      : text.replace(activeEndTrimPattern, '');
    return stripWhitespaceInsideMassShells(trimmed, edge);
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

  return Object.freeze({ DEFAULT_EXTRA_SPLIT_TRIM_SYMBOLS, DEFAULT_SPLIT_TRIM_SYMBOLS, SPLIT_TRIM_PRIMARY_SYMBOLS, applySplitEdgeTrim, cleanSplitTextParts, escapeSplitTrimPatternSource, normalizeSplitTrimSymbols, parseSplitTrimSymbolInput, setSplitTrimSymbols });
}
