// === 表情包烧录计划：把当前工程的表情包区间与预览几何编译成烧录请求字段 ===
// 方案一（固定位置）：所有表情包图片出现在 preview.sticker 几何对应位置，与
// 表情包预览层同一套归一化几何；服务端把这些像素矩形交给 FFmpeg overlay 滤镜
// （contain 缩放 + 层内居中），与 ass 字幕在同一张滤镜图串联一次性编码。
// 区间收集契约与表情包预览层（rebuildStickerIntervals）一致：主轨 + 叠加轨、
// ref 解析 head、跳过禁用段、同一 rel 合并 enable 区间。
(function initMaweStickerBurnPlan(global) {
  'use strict';

  // preview.sticker 几何 × 视频分辨率 → 像素层矩形。服务端只做整数校验，
  // 图片原始尺寸的 contain 缩放由 FFmpeg scale 表达式完成，前端不读图片。
  function stickerLayerBox(geometry, resolution) {
    const scale = (value, total) => Math.max(0, Math.round(Number(value) * total));
    return {
      x: scale(geometry.x, resolution.width),
      y: scale(geometry.y, resolution.height),
      width: scale(geometry.width, resolution.width),
      height: scale(geometry.height, resolution.height),
    };
  }

  // 烧录跟随「预览表情包」开关：与预览所见即所得，总开关关闭时同样不烧。
  function stickerBurnEnabled() {
    return Boolean(global.MaweDom?.stickerOverlayToggle?.checked)
      && global.MaweSettings?.EDITOR_SETTINGS?.stickersEnabled !== false;
  }

  // 收集唯一表情包文件的合并显示区间（毫秒）。gapRemoved 提供时按收缩时间轴
  // 映射端点（与去空隙 ASS 同一 mapGapRemovedTime 契约：请求里的时间已是最终
  // 时间轴），完全落在已移除空隙内的区间丢弃。
  function collectStickerPlans({ gapRemoved = null, resolution = null } = {}) {
    if (!stickerBurnEnabled() || !Number.isInteger(resolution?.width)
      || !Number.isInteger(resolution?.height) || resolution.width < 1 || resolution.height < 1) return [];
    const overlay = global.MaweStickerOverlay;
    if (!overlay) return [];
    overlay.rebuildStickerIntervals();
    const merged = new Map(); // rel -> { rel, intervals: [{ start, end }] }
    overlay.stickerIntervals.forEach((interval) => {
      const rel = interval.source?.rel;
      if (typeof rel !== 'string' || !rel.trim()) return;
      let start = Number(interval.start);
      let end = Number(interval.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
      if (gapRemoved) {
        const mapTime = global.AsrEditorUtils?.mapGapRemovedTime;
        if (typeof mapTime !== 'function') return;
        start = mapTime(start, gapRemoved);
        end = mapTime(end, gapRemoved);
        if (end <= start) return;
      }
      const key = rel.trim();
      const entry = merged.get(key);
      if (entry) entry.intervals.push({ start: Math.round(start), end: Math.round(end) });
      else merged.set(key, { rel: key, intervals: [{ start: Math.round(start), end: Math.round(end) }] });
    });
    if (!merged.size) return [];
    const box = stickerLayerBox(global.MawePreviewGeometry.getStickerGeometry(), resolution);
    if (box.width < 1 || box.height < 1) return []; // 预览层几何无效时不烧表情包
    return [...merged.values()].map((entry) => ({ ...entry, ...box }));
  }

  global.MaweStickerBurnPlan = Object.freeze({ stickerBurnEnabled, collectStickerPlans, stickerLayerBox });
})(typeof window !== 'undefined' ? window : globalThis);
