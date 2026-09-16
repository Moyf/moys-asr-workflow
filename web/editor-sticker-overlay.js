// 表情包浮层：叠加层渲染与区间缓存。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweStickerOverlay 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweStickerOverlay(global) {
  'use strict';



  // 合成表情包文件的 URL（用于 <img src>）
  // 优先级:
  let stickerAssetRevision = 0;


  // === 表情包预览（视频画面内）===
  // 层位置/尺寸由 preview.sticker 几何驱动（默认右上角）；点击后可拖动/缩放，与字幕预览同一套交互。
  const stickerOverlayLayer = document.createElement('div');


  const stickerOverlayContent = document.createElement('div');



  let stickerOverlayDataVersion = 0;


  let stickerIntervalCacheVersion = -1;


  let stickerIntervals = [];


  let stickerIntervalBoundaries = [];


  let activeStickerCacheVersion = -1;


  let activeStickerCacheTime = -Infinity;


  let activeStickerCacheUntil = -Infinity;


  let activeStickerCache = [];


  let renderedStickerSignature = null;


  let renderedStickerOverlayEnabled = false;



  function rebuildStickerIntervals() {
  if (stickerIntervalCacheVersion === stickerOverlayDataVersion) return;
  const intervals = [];
  const boundaries = new Set();
  // 收集一条轨的表情包区间：ref 在所在轨数组内解析 head。
  // track 标记归属（主轨/叠加轨），供叠加表情包显示时的预览层加高判断使用。
  const collect = (segments, track) => {
    segments.forEach((seg) => {
      if (seg.disabled) return;
      const head = segments[seg.sticker_ref?.headIdx] || seg;
      // ref 成员的 head 被禁用时同样不收集，保持 enabled=false 的显示契约。
      if (head !== seg && head.disabled) return;
      const source = seg.sticker || head.sticker;
      if (!source) return;
      const start = Number(source.start ?? head.start);
      const end = Number(source.end ?? head.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return;
      intervals.push({ start, end, source, key: source.filename || source.name, track });
      boundaries.add(start);
      boundaries.add(end);
    });
  };
  collect(MaweBoot.DATA.segments, 'main');
  collect(getOverlayTrack()?.segments || [], 'overlay');
  stickerIntervals = intervals;
  stickerIntervalBoundaries = [...boundaries].sort((a, b) => a - b);
  stickerIntervalCacheVersion = stickerOverlayDataVersion;
  activeStickerCacheVersion = -1;
  activeStickerCacheTime = -Infinity;
  activeStickerCacheUntil = -Infinity;
  activeStickerCache = [];
  activeStickerHasOverlay = false;
}



  function activeStickersAt(tMs) {
  rebuildStickerIntervals();
  const time = Number(tMs);
  if (
    activeStickerCacheVersion === stickerOverlayDataVersion
    && time >= activeStickerCacheTime
    && time < activeStickerCacheUntil
  ) return activeStickerCache;

  const found = new Map();  // 同组 head/ref 去重，按文件名键
  stickerIntervals.forEach((interval) => {
    if (time >= interval.start && time <= interval.end) found.set(interval.key, interval.source);
  });
  // 当前时刻是否有叠加轨表情包在显示（同名素材在主轨同时显示时也算——
  // 预览层展示的就是这张图，叠加归属用于决定预览内容区是否加高）。
  activeStickerHasOverlay = stickerIntervals.some((interval) => (
    interval.track === 'overlay'
    && time >= interval.start && time <= interval.end
    && found.has(interval.key)
  ));
  // 播放时间单调前进时，缓存只需保留到下一个边界；二分定位避免每次
  // 表情包切换都再次扫描全部边界。边界采用半开缓存区间，确保切换帧
  // 立刻显示新表情包，而不是多停留一帧旧内容。
  let low = 0;
  let high = stickerIntervalBoundaries.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (stickerIntervalBoundaries[middle] <= time) low = middle + 1;
    else high = middle;
  }
  const nextChange = stickerIntervalBoundaries[low] ?? Infinity;
  activeStickerCacheVersion = stickerOverlayDataVersion;
  activeStickerCacheTime = time;
  activeStickerCacheUntil = nextChange;
  activeStickerCache = [...found.values()];
  return activeStickerCache;
}



  function renderStickerOverlay(tMs) {
  const enabled = Boolean(MaweDom.stickerOverlayToggle?.checked);
  if (!enabled) {
    if (renderedStickerOverlayEnabled || stickerOverlayContent.childElementCount
      || stickerOverlayContent.classList.contains('has-overlay-sticker')) {
      stickerOverlayContent.replaceChildren();
      stickerOverlayContent.classList.remove('has-overlay-sticker');
    }
    renderedStickerOverlayEnabled = false;
    renderedStickerSignature = null;
    return;
  }
  const stickers = activeStickersAt(tMs);
  // 签名带上叠加归属：同名素材的显示集合不变但叠加状态翻转时也要切换 class。
  const signature = `${activeStickerHasOverlay ? 'O' : ''}\u0001${
    stickers.map((sticker) => sticker.filename || sticker.name).join('\u0001')
  }`;
  if (renderedStickerOverlayEnabled && renderedStickerSignature === signature) return;
  stickerOverlayContent.classList.toggle('has-overlay-sticker', activeStickerHasOverlay);
  stickerOverlayContent.replaceChildren(...stickers.map((sticker) => {
    const img = document.createElement('img');
    img.src = MaweSelection.stickerUrl(sticker);
    img.alt = sticker.name;
    img.title = sticker.name;
    return img;
  }));
  renderedStickerOverlayEnabled = true;
  renderedStickerSignature = signature;
}

  global.MaweStickerOverlay = Object.freeze({
    get stickerAssetRevision() { return stickerAssetRevision; },
    set stickerAssetRevision(v) { stickerAssetRevision = v; },
    stickerOverlayLayer,
    stickerOverlayContent,
    get stickerOverlayDataVersion() { return stickerOverlayDataVersion; },
    set stickerOverlayDataVersion(v) { stickerOverlayDataVersion = v; },
    get stickerIntervalCacheVersion() { return stickerIntervalCacheVersion; },
    set stickerIntervalCacheVersion(v) { stickerIntervalCacheVersion = v; },
    get stickerIntervals() { return stickerIntervals; },
    set stickerIntervals(v) { stickerIntervals = v; },
    get stickerIntervalBoundaries() { return stickerIntervalBoundaries; },
    set stickerIntervalBoundaries(v) { stickerIntervalBoundaries = v; },
    get activeStickerCacheVersion() { return activeStickerCacheVersion; },
    set activeStickerCacheVersion(v) { activeStickerCacheVersion = v; },
    get activeStickerCacheTime() { return activeStickerCacheTime; },
    set activeStickerCacheTime(v) { activeStickerCacheTime = v; },
    get activeStickerCacheUntil() { return activeStickerCacheUntil; },
    set activeStickerCacheUntil(v) { activeStickerCacheUntil = v; },
    get activeStickerCache() { return activeStickerCache; },
    set activeStickerCache(v) { activeStickerCache = v; },
    get renderedStickerSignature() { return renderedStickerSignature; },
    set renderedStickerSignature(v) { renderedStickerSignature = v; },
    get renderedStickerOverlayEnabled() { return renderedStickerOverlayEnabled; },
    set renderedStickerOverlayEnabled(v) { renderedStickerOverlayEnabled = v; },
    rebuildStickerIntervals,
    activeStickersAt,
    renderStickerOverlay
  });
})(typeof window !== 'undefined' ? window : globalThis);
