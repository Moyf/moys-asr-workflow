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
      // 下拉选择也保留 face 粒度，搜索 Semibold/PS 名不能选成 Regular。
      entries.push(...faces.values());
    }
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
  function chainCssFor(name) {
    const chain = aliasChainFor(name);
    if (!chain) return '';
    return global.AsrEditorUtils?.assFontFamilyAliasChainCss?.(name, chain) || '';
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

  async function loadAliases() {
    if (!config?.assFontAliasesUrl || ready) return;
    try {
      const response = await fetch(new URL(config.assFontAliasesUrl, global.location.href), {
        cache: 'no-store',
      });
      if (!response.ok) return;
      const payload = await response.json();
      if (!ingest(payload)) return;
      // 别名链改变预览字体匹配结果：清掉画布行/字体度量缓存并刷新预览与
      // 下拉；导出排版计划缓存经 mawe:ass-font-aliases-loaded 事件失效。
      global.MaweAssCanvas?.clearCaches?.();
      document.dispatchEvent(new CustomEvent('mawe:ass-font-aliases-loaded'));
      global.MawePlaybackLoop?.refreshSubtitlePreview?.();
    } catch (_) {
      // 端点不存在（旧服务器）或请求失败：保持未加载，全部消费点走现状。
    }
  }

  global.MaweAssFontAliases = Object.freeze({
    loaded: () => ready,
    entries: () => entries.map((entry) => ({ ...entry, names: [...entry.names] })),
    canonicalFor,
    aliasChainFor,
    chainCssFor,
    beginReplacementCapture,
    endReplacementCapture,
    takeReplacementNotice,
    reload: loadAliases,
  });
  void loadAliases();
})(typeof window !== 'undefined' ? window : globalThis);
