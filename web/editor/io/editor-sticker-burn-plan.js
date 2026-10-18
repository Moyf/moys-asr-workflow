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
  function collectStickerIntervals({ gapRemoved = null } = {}) {
    const overlay = global.MaweStickerOverlay;
    if (!overlay) return [];
    overlay.rebuildStickerIntervals();
    const windows = [];
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
      windows.push({ rel: rel.trim(), start: Math.round(start), end: Math.round(end) });
    });
    return windows;
  }

  // 方案一（固定位置）：同一 rel 的窗口合并 enable 区间，一张图一个 placement；
  // 服务端 contain 在目标框内居中。
  function collectFixedPlacements({ windows, box }) {
    const merged = new Map();
    windows.forEach((window) => {
      const entry = merged.get(window.rel);
      const interval = { start: window.start, end: window.end };
      if (entry) entry.intervals.push(interval);
      else merged.set(window.rel, { rel: window.rel, x: box.x, y: box.y,
        width: box.width, height: box.height, align: 'center', intervals: [interval] });
    });
    return [...merged.values()];
  }

  // 烧录表情包载荷。mode:
  // - 'fixed'（默认）：所有表情包出现在 preview.sticker 几何对应位置；
  // - 'cue-left'：显示窗口与主字幕句重叠的段贴在该句第一个字左侧（placement
  //   模块按排版计划推导，placement 自带 align=right），句间空隙 / legacy 句 /
  //   会出画等回退段 align=center（与方案一相同的服务端 contain 居中）。
  // plan 是 buildAss(onAssPlan) 的排版计划——与请求携带的 ASS 文本同一份
  // （同一时间轴、同一折行结果），保证字幕与表情包位置同源。
  // 返回 {mode, placements} 对象（服务端按 placement 的 align 决定 contain
  // 对齐：fixed 居中、cue-left 贴放段右对齐）；无可烧内容时返回 null。
  function collectStickerPlans({ gapRemoved = null, resolution = null, mode = 'fixed', plan = null } = {}) {
    if (!stickerBurnEnabled() || !Number.isInteger(resolution?.width)
      || !Number.isInteger(resolution?.height) || resolution.width < 1 || resolution.height < 1) return null;
    const windows = collectStickerIntervals({ gapRemoved });
    if (!windows.length) return null;
    const box = stickerLayerBox(global.MawePreviewGeometry.getStickerGeometry(), resolution);
    if (box.width < 1 || box.height < 1) return null; // 预览层几何无效时不烧表情包
    const resolvedMode = mode === 'cue-left' ? 'cue-left' : 'fixed';
    if (resolvedMode === 'cue-left') {
      const placements = global.AsrEditorUtils?.computeStickerCuePlacements?.({
        plan, windows, fixedBox: box,
      });
      if (Array.isArray(placements)) return { mode: resolvedMode, placements };
    }
    return { mode: 'fixed', placements: collectFixedPlacements({ windows, box }) };
  }

  global.MaweStickerBurnPlan = Object.freeze({
    stickerBurnEnabled, collectStickerPlans, collectStickerIntervals, stickerLayerBox,
  });
})(typeof window !== 'undefined' ? window : globalThis);
