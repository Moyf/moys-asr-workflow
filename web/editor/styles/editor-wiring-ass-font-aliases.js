// 服务端 ASS 字体别名表：libass（Windows directwrite/GDI 提供器）只按字体
// nameID1（GDI 兼容 family）匹配，样式里存的排版名（nameID16，如
// "Smiley Sans"）会被静默回退。启动时拉取本机字体别名表，供导出归一化
// （ass-export）、ASS 字体下拉（font-geometry）与预览别名链（ass-preview /
// ass-canvas）共用。
//
// 便携模式（无 SERVER_CONFIG）、旧服务器（端点不存在）与请求失败时保持
// 未加载状态：所有消费点降级为现状行为。
(function initMaweAssFontAliases(global) {
  'use strict';

  const SCHEMA = 'moy.asr.font_aliases.v1';
  const config = global.MaweBoot?.SERVER_CONFIG;
  const entries = [];
  const canonicalByFold = new Map();
  const renderableFamilies = new Set();
  let ready = false;
  let coverage = null;
  let pending = false;
  let settled = Promise.resolve();
  let coveragePending = false;
  let coverageAttempted = false;
  let coverageSettled = Promise.resolve();
  let finishLoading = null;
  const faceCache = new Map();
  const segmenter = typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

  // No code-point fallback: on older engines keeping a whole span is safer
  // than detaching combining marks, variation selectors or ZWJ components.
  function graphemes(text) {
    return segmenter ? Array.from(segmenter.segment(String(text)), item => item.segment) : [String(text)];
  }

  function safeFontName(name) {
    return typeof name === 'string' && name.trim() && !/[{}\\\r\n]/u.test(name);
  }

  function faceFor(name, bold, italic) {
    if (!coverage || !safeFontName(name)) return null;
    const key = JSON.stringify([fold(name), Boolean(bold), Boolean(italic)]);
    if (faceCache.has(key)) return faceCache.get(key);
    const canonical = canonicalFor(name) || name;
    const candidates = coverage.faces.filter(face => safeFontName(face.family) &&
      [face.family, ...(face.names || [])].some(n => fold(n) === fold(canonical)));
    // Match style before weight; regular-only fonts may be synthetically bold
    // in both renderers, but that is explicitly not a pixel-parity guarantee.
    candidates.sort((a, b) =>
      (Number(Boolean(a.italic) !== Boolean(italic)) * 1000 + Math.abs(a.weight - (bold ? 700 : 400)))
      - (Number(Boolean(b.italic) !== Boolean(italic)) * 1000 + Math.abs(b.weight - (bold ? 700 : 400))));
    const result = candidates[0] || null;
    faceCache.set(key, result);
    return result;
  }

  function covers(face, text) {
    return Boolean(face) && [...text].every(ch => {
      const cp = ch.codePointAt(0);
      if (ch === '\n' || ch === '\r' || ch === '\t') return true;
      const ranges = face.ranges || coverage.cmaps?.[face.cmap] || [];
      let low = 0, high = ranges.length - 1;
      while (low <= high) {
        const middle = (low + high) >> 1;
        const [start, end] = ranges[middle];
        if (cp < start) high = middle - 1;
        else if (cp > end) low = middle + 1;
        else return true;
      }
      return false;
    });
  }

  // Managed scope: ordinary text and combining graphemes. Never split joining
  // scripts/bidi spans to chase cmap coverage; coverage alone is not shaping.
  // Emoji sequences stay intact and retain the old renderer-dependent fallback.
  const emoji = /[\p{Extended_Pictographic}\uFE0E\uFE0F\u20E3\u{1F1E6}-\u{1F1FF}]/u;
  function resolveRuns(runs, style) {
    if (!coverage) return runs;
    const result = [];
    for (const inputRun of runs) {
      const resolutionStyle = JSON.stringify([style.fontName, Boolean(style.bold), Boolean(style.italic || inputRun.italic)]);
      if (inputRun.fontResolutionStyle === resolutionStyle) { result.push(inputRun); continue; }
      const { fontName: oldFont, fontEmRatio: oldRatio, fontFallbackStatus: oldStatus,
        fontResolutionStyle: oldStyle, ...sourceRun } = inputRun;
      const run = { ...sourceRun, fontResolutionStyle: resolutionStyle };
      const primary = style.fontName;
      const bold = Boolean(style.bold);
      const italic = Boolean(style.italic || run.italic);
      const face = faceFor(primary, bold, italic);
      if (!face) {
        result.push({ ...run, fontFallbackStatus: 'unknown-primary' });
        continue;
      }
      if (!global.AsrEditorUtils?.assManagedFontText?.(run.text) || !segmenter) {
        result.push({ ...run, fontFallbackStatus: 'unmanaged-shaping' });
        continue;
      }
      let last = null;
      for (const text of graphemes(run.text)) {
        let selected = covers(face, text) ? face : null;
        let selectedName = primary;
        let status = 'managed';
        if (emoji.test(text)) { selected = null; status = 'unmanaged-emoji'; }
        else if (!selected) {
          // Use the requested, matchable family spelling. A locale-selected
          // nameID1 (e.g. 蘋方-簡) can fail CoreText inline lookup even though the
          // same face's English name PingFang SC succeeds.
          for (const name of coverage.fallbacks) {
            const candidate = faceFor(name, bold, italic);
            if (covers(candidate, text)) {
              selected = candidate;
              selectedName = canonicalFor(name) || name;
              break;
            }
          }
          if (!selected) status = 'uncovered';
        }
        const fontName = selected ? selectedName : primary;
        const fontEmRatio = selected && selected !== face ? selected.emRatio : undefined;
        if (last && last.fontName === fontName && last.fontFallbackStatus === status) last.text += text;
        else {
          last = { ...run, text, fontName, fontEmRatio, fontFallbackStatus: status };
          result.push(last);
        }
      }
    }
    return result;
  }


  // 导出替换捕获窗口：仅 .ass 下载入口在 buildAss 前后开启，预览等高频
  // buildAss 的归一化不会污染替换记录。
  let captureDepth = 0;
  let captured = [];

  function fold(name) {
    return String(name ?? '').trim().toLocaleLowerCase();
  }

  function ingest(payload) {
    if (!payload || payload.schema !== SCHEMA || !Array.isArray(payload.fonts)) return false;
    entries.length = 0;
    canonicalByFold.clear();
    renderableFamilies.clear();
    for (const entry of payload.fonts) {
      const canonical = typeof entry?.canonical === 'string' ? entry.canonical.trim() : '';
      if (!canonical) continue;
      const names = [...new Set([canonical, ...(Array.isArray(entry.names) ? entry.names : [])]
        .map((name) => String(name ?? '').trim())
        .filter(Boolean))];
      const faces = new Map();
      for (const name of Array.isArray(entry.family) ? entry.family : []) {
        const key = fold(name);
        if (key) renderableFamilies.add(key);
      }
      for (const name of names) {
        const key = fold(name);
        const faceCanonical = typeof entry.canonicalByName?.[key] === 'string'
          ? entry.canonicalByName[key].trim() : '';
        if (!canonicalByFold.has(key)) canonicalByFold.set(key, faceCanonical || canonical);
        const target = canonicalByFold.get(key);
        if (!faces.has(target)) faces.set(target, { canonical: target, names: [] });
        faces.get(target).names.push(name);
      }
      // legacy（坏 Macintosh 记录的脏名，如「寒蝉活仿楷__ Con」）只进查询表：
      // 旧工程存量的脏名仍能解析出可匹配 canonical（导出改写 + 预览别名链），
      // 但不进 entries——字体下拉不能展示 libass 匹配不到的死名字。
      for (const name of Array.isArray(entry.legacy) ? entry.legacy : []) {
        const key = fold(name);
        if (!key || canonicalByFold.has(key)) continue;
        const faceCanonical = typeof entry.canonicalByName?.[key] === 'string'
          ? entry.canonicalByName[key].trim() : '';
        if (faceCanonical) canonicalByFold.set(key, faceCanonical);
      }
      // 下拉选择也保留 face 粒度，搜索 Semibold/PS 名不能选成 Regular。
      entries.push(...faces.values());
    }
    coverage = payload.coverage?.schema === 'moy.asr.font_coverage.v1'
      && Array.isArray(payload.coverage.faces) && Array.isArray(payload.coverage.fallbacks)
      ? payload.coverage : null;
    faceCache.clear();
    ready = true;
    return true;
  }

  // 存储名 → 本机 canonical 名（大小写不敏感）；未加载或查不到返回 null。
  function canonicalFor(name) {
    if (!ready) return null;
    const key = fold(name);
    // 与服务端一致：已可匹配的 nameID1 保留原值，避免 Semibold 等 face
    // 因共享排版名被改写成 Regular；非 nameID1 的别名仍归一化。
    if (renderableFamilies.has(key)) return String(name ?? '').trim();
    const canonical = canonicalByFold.get(key);
    if (!canonical) return null;
    if (captureDepth > 0 && canonical !== String(name ?? '').trim()) {
      const record = { from: String(name).trim(), to: canonical };
      if (!captured.some((item) => item.from === record.from && item.to === record.to)) {
        captured.push(record);
      }
    }
    return canonical;
  }

  // 预览别名链（不含存储名本身）：canonical 优先、其余别名跟随；表未加载
  // 或存储名不在表中时返回 null，调用方退化为现有单名输出。
  function aliasChainFor(name) {
    if (!ready) return null;
    const key = fold(name);
    const canonical = canonicalByFold.get(key);
    if (!canonical) return null;
    const entry = entries.find((item) => item.names.some((name) => fold(name) === key));
    const names = entry ? entry.names : [canonical];
    const chain = [];
    const seen = new Set([key, fold(canonical)]);
    if (fold(canonical) !== key) chain.push(canonical);
    for (const name of names) {
      const nameKey = fold(name);
      if (!nameKey || seen.has(nameKey)) continue;
      if (canonicalByFold.get(nameKey) !== canonical) continue;
      seen.add(nameKey);
      chain.push(name);
    }
    return chain;
  }

  // CSS font-family 别名链：`"<存储值>", "<canonical>", "<其余别名>", sans-serif`。
  // 返回 '' 表示未加载/查不到，调用方沿用现有 font-family 输出。
  function chainCssFor(name, options) {
    const chain = aliasChainFor(name);
    if (!chain) return '';
    return global.AsrEditorUtils?.assFontFamilyAliasChainCss?.(name, chain, options) || '';
  }

  function beginReplacementCapture() {
    captureDepth += 1;
    if (captureDepth === 1) captured = [];
  }

  function endReplacementCapture() {
    captureDepth = Math.max(0, captureDepth - 1);
  }

  function takeReplacementNotice() {
    return captured.splice(0);
  }

  function ensureCoverage() {
    if (coverage || coverageAttempted || !config?.assFontCoverageUrl) return coverageSettled;
    // Publish pending synchronously, before the alias await, so native frame
    // requests cannot race the transition from the lightweight startup path.
    coverageAttempted = true;
    coveragePending = true;
    coverageSettled = (async () => {
      await settled;
      const controller = typeof global.AbortController === 'function' ? new global.AbortController() : null;
      let timeout;
      try {
        const request = (async () => {
          const response = await fetch(new URL(config.assFontCoverageUrl, global.location.href), {
            cache: 'no-store', signal: controller?.signal,
          });
          return response.ok ? response.json() : null;
        })();
        const deadline = new Promise((_, reject) => {
          timeout = global.setTimeout?.(() => {
            controller?.abort();
            reject(new Error('Font coverage timed out'));
          }, 30000);
        });
        const payload = await Promise.race([request, deadline]);
        if (payload?.schema === 'moy.asr.font_coverage.v1'
            && Array.isArray(payload.faces) && Array.isArray(payload.fallbacks)) {
          coverage = payload;
          faceCache.clear();
          // Same invalidation contract as alias changes, including stack plans.
          global.MaweAssCanvas?.clearCaches?.();
          document.dispatchEvent(new CustomEvent('mawe:ass-font-aliases-loaded'));
        }
      } catch (_) {
        // Old/offline servers settle to the legacy path, not an endless retry
        // loop driven by playback or the settled notification itself.
      } finally {
        global.clearTimeout?.(timeout);
        coveragePending = false;
        document.dispatchEvent(new CustomEvent('mawe:ass-font-aliases-settled'));
        global.MawePlaybackLoop?.refreshSubtitlePreview?.();
      }
    })();
    return coverageSettled;
  }

  async function loadAliases() {
    if (!config?.assFontAliasesUrl || ready || pending) return;
    pending = true;
    settled = new Promise(resolve => { finishLoading = resolve; });
    const controller = typeof global.AbortController === 'function' ? new global.AbortController() : null;
    let timeout;
    try {
      // Bound the entire request AND JSON body read. A stalled font endpoint
      // must not indefinitely disable native preview/export or prevent retry.
      const request = (async () => {
        const response = await fetch(new URL(config.assFontAliasesUrl, global.location.href), {
          cache: 'no-store', signal: controller?.signal,
        });
        return response.ok ? response.json() : null;
      })();
      const deadline = new Promise((_, reject) => {
        timeout = global.setTimeout?.(() => {
          controller?.abort();
          reject(new Error('Font inventory timed out'));
        }, 30000);
      });
      const payload = await Promise.race([request, deadline]);
      if (!ingest(payload)) return;
      pending = false;
      // 别名链改变预览字体匹配结果：清掉画布行/字体度量缓存并刷新预览与
      // 下拉；导出排版计划缓存经 mawe:ass-font-aliases-loaded 事件失效。
      global.MaweAssCanvas?.clearCaches?.();
      document.dispatchEvent(new CustomEvent('mawe:ass-font-aliases-loaded'));
      global.MawePlaybackLoop?.refreshSubtitlePreview?.();
    } catch (_) {
      // 端点不存在（旧服务器）或请求失败：保持未加载，全部消费点走现状。
    } finally {
      global.clearTimeout?.(timeout);
      pending = false;
      finishLoading?.();
      finishLoading = null;
      // Failed/old endpoints also settle into the legacy rendering path.
      document.dispatchEvent(new CustomEvent('mawe:ass-font-aliases-settled'));
    }
  }

  global.MaweAssFontAliases = Object.freeze({
    loaded: () => ready,
    pending: () => pending || coveragePending,
    whenReady: async () => { await settled; await coverageSettled; },
    ensureCoverage,
    entries: () => entries.map((entry) => ({ ...entry, names: [...entry.names] })),
    canonicalFor,
    resolveRuns,
    graphemes,
    coverageAvailable: () => Boolean(coverage),
    aliasChainFor,
    chainCssFor,
    beginReplacementCapture,
    endReplacementCapture,
    takeReplacementNotice,
    reload: loadAliases,
  });
  void loadAliases();
})(typeof window !== 'undefined' ? window : globalThis);
