// preview-geometry: private helpers; dependencies are injected by editor-utils.js.
window.MAWE.register('utils-preview-geometry', function createUtilsModule(dependencies) {
  'use strict';


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

  return Object.freeze({ DEFAULT_PREVIEW_GEOMETRY, DEFAULT_STICKER_GEOMETRY, PREVIEW_MIN_HEIGHT, PREVIEW_MIN_WIDTH, applyPreviewGeometryDelta, clampPreviewGeometry, normalizePreviewGeometry, previewGeometryToCss });
});
