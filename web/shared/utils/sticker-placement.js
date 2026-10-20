// sticker-placement: 表情包烧录「显示在字幕第一个字左侧」（方案二）的纯布局计算。
// 只做数值计算，不触碰 DOM/Canvas/FFmpeg：位置来自 onAssPlan 排版计划（与
// Canvas 字幕预览同一份），Node 测试可用假 plan 离线验证。坐标全部是
// PlayRes 像素、请求时间轴（去空隙时由调用方传入已收缩的计划与窗口）。
export function createUtilsModule(dependencies) {

  'use strict';

  const assStackFrame = dependencies.assStackFrame;

  // 目标框相对字号的比例：高约 1.5 倍字号（与行盒同量级）、宽 4 倍字号；
  // 图片在框内 contain 缩放（服务端按对齐模式放置），窄图宽图都不失真。
  const TARGET_RATIO = Object.freeze({ width: 4, height: 1.5 });
  // 墨盒左缘到表情包目标框右缘的视觉余量比例（× 字号）：墨盒 rect 已含
  // 描边/阴影外扩，这里只补 canvas↔libass 度量差的余量。
  const GAP_RATIO = 0.12;

  const clampIndex = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

  // 把一个窗口按字幕排布边界切成段：主字幕 cue 起止 + slice 起止都要参与
  // 切分——同一主句跨 slice（例如叠加字幕出现/消失）时布局可能切换
  // （legacy ↔ 堆叠、位置与缩放变化），中点采样必须落在同一段内才准确。
  // 返回 [{start, end, cue}]，cue 为覆盖该段的主字幕（null = 句间空隙段）。
  // 短段也保留自己的布局边界，避免中点跨入另一布局或丢失窗口开头；
  // 最终几何相同的段由 mergePlacementIntervals 合并。
  function splitWindowByCues(cues, bounds, win) {
    const points = new Set([win.start, win.end]);
    for (const cue of cues) {
      if (cue.start > win.start && cue.start < win.end) points.add(cue.start);
      if (cue.end > win.start && cue.end < win.end) points.add(cue.end);
    }
    for (const bound of bounds) {
      if (bound > win.start && bound < win.end) points.add(bound);
    }
    const ordered = [...points].sort((a, b) => a - b);
    const segments = [];
    for (let index = 0; index < ordered.length - 1; index += 1) {
      const start = ordered[index];
      const end = ordered[index + 1];
      const middle = (start + end) / 2;
      segments.push({ start, end,
        cue: cues.find(cue => middle >= cue.start && middle < cue.end
          && middle >= cue.slice.start && middle < cue.slice.end) || null });
    }
    return segments;
  }

  // 段内字幕左缘几何：从中点取排版帧（与 Canvas 预览同一 assStackFrame），
  // 找到承载 cue 的条目，按墨盒 rect（已含描边/阴影外扩）左缘推出表情包
  // 目标框：右缘 = 墨盒左缘 - gap，垂直中心 = 墨盒中心（多行句为块中心）。
  // 目标框必须完整落在画面内（任何一边越界都会让服务端拒绝或裁切），加上
  // legacy 句的折行与 libass 不一致，这些情况返回 null（调用方回退固定位置）。
  function cueLeftBox(plan, cue, segmentMiddle) {
    const frame = assStackFrame(plan, segmentMiddle);
    if (frame?.diagnostic) return null;
    const item = (frame?.items || []).find(item => item.role === 'main'
      && item.start === cue.start && item.end === cue.end);
    if (!item || item.legacy) return null;
    const scale = clampIndex(item.scale, 1);
    const rect = item.rect;
    const anchor = item.anchor;
    if (!rect || !anchor) return null;
    const fontSizePx = clampIndex(item.fontSize, 0) * clampIndex(item.cueScale, 1) * scale;
    if (fontSizePx < 4) return null;
    const height = Math.max(1, Math.round(fontSizePx * TARGET_RATIO.height));
    const width = Math.max(1, Math.round(fontSizePx * TARGET_RATIO.width));
    const gap = Math.max(4, Math.round(fontSizePx * GAP_RATIO));
    const inkLeft = anchor.x + rect.left * scale;
    const x = Math.round(inkLeft - gap - width);
    if (x < 0) return null;
    const centerY = anchor.y + ((rect.top + rect.bottom) / 2) * scale
      + clampIndex(item.shakeOffset?.y, 0);
    const y = Math.round(centerY - height / 2);
    const width2 = Number(plan?.width) || 0;
    const height2 = Number(plan?.height) || 0;
    if (width2 > 0 && height2 > 0
      && (x + width > width2 || y < 0 || y + height > height2)) return null;
    return { x, y, width, height, align: 'right' };
  }

  function fixedBoxPlacement(rel, interval, fixedBox) {
    return { rel, x: fixedBox.x, y: fixedBox.y, width: fixedBox.width, height: fixedBox.height,
      align: 'center', intervals: [interval] };
  }

  function mergePlacementIntervals(placements) {
    // 同 rel、同坐标且同对齐的 placement 合并区间，减少 FFmpeg overlay 节点数。
    const merged = [];
    for (const placement of placements) {
      const previous = merged[merged.length - 1];
      if (previous && previous.rel === placement.rel && previous.align === placement.align
        && previous.x === placement.x && previous.y === placement.y
        && previous.width === placement.width && previous.height === placement.height) {
        previous.intervals.push(...placement.intervals);
        continue;
      }
      merged.push(placement);
    }
    return merged;
  }

  // 把表情包窗口集合编译成 placements。windows: [{rel, start, end}]（毫秒、
  // 最终时间轴）；fixedBox 为回退固定矩形（方案一几何，像素）；多图同屏时
  // 时间重叠的窗口只有第一张贴字幕左侧，其余回退固定位置。
  /**
   * @param {{ plan?: { slices?: Array<{ start?: number, end?: number, legacy?: boolean,
   *   pieces?: Array<{ start?: number, end?: number, instant?: number | null,
   *   from?: { x: number, y: number }, to?: { x: number, y: number } }>,
   *   items?: Array<{ role?: string, start?: number, end?: number, legacy?: boolean,
   *   manual?: boolean, absolute?: boolean, scale?: number, cueScale?: number,
   *   fontSize?: number, shakeOffset?: { x?: number, y?: number },
   *   offset?: { x: number, y: number },
   *   rect?: { left: number, top: number, right: number, bottom: number } }> }>,
   *   width?: number, height?: number },
   *   windows?: Array<{ rel: string, start: number, end: number }>,
   *   fixedBox?: { x: number, y: number, width: number, height: number }}} [options]
   * @returns {Array<{ rel: string, x: number, y: number, width: number, height: number,
   *   align: 'center' | 'right', intervals: Array<{ start: number, end: number }> }>}
   */
  function computeStickerCuePlacements({ plan, windows, fixedBox } = {}) {
    const box = fixedBox && Number.isFinite(Number(fixedBox?.x)) ? fixedBox : null;
    const cues = [];
    // slice 起止是布局变化边界（叠加/副字幕进出会改变主句的排布方式）；
    // piece 的 instant（方案瞬切）也是位置跳变点，同样参与切段。
    const bounds = [];
    for (const slice of plan?.slices || []) {
      if (Number.isFinite(slice?.start)) bounds.push(slice.start);
      if (Number.isFinite(slice?.end)) bounds.push(slice.end);
      if (slice?.legacy) continue;
      for (const piece of slice.pieces || []) {
        if (Number.isFinite(piece?.instant)) bounds.push(piece.instant);
      }
      for (const item of slice.items || []) {
        if (item.role !== 'main') continue;
        // 带上所属 slice：线性移动段（from→to）内固定采样必然漂移，
        // 承载句的 slice 需要被识别并回退固定位置。
        cues.push({ start: item.start, end: item.end, slice });
      }
    }
    cues.sort((a, b) => a.start - b.start);
    const ordered = [...(windows || [])]
      .filter(win => Number.isFinite(win.start) && Number.isFinite(win.end) && win.end > win.start)
      .sort((a, b) => a.start - b.start || String(a.rel).localeCompare(String(b.rel)));
    // 同 rel 的重叠窗口合并为并集：扩展表情包（head + 多个 sticker_ref）在
    // 窗口收集阶段会产生同 rel 的重复窗口（预览层同一时刻同一张图只显示
    // 一次），不合并的话第一张贴字幕、其余会错误地落到固定位置造成双显。
    const deduped = [];
    for (const win of ordered) {
      const last = deduped[deduped.length - 1];
      if (last && last.rel === win.rel && win.start <= last.end) {
        last.end = Math.max(last.end, win.end);
      } else deduped.push({ rel: win.rel, start: win.start, end: win.end });
    }
    const cuePlacements = [];
    const fixedPlacements = [];
    const occupied = [];
    for (const win of deduped) {
      const fallback = () => {
        if (box) fixedPlacements.push(fixedBoxPlacement(win.rel, { start: win.start, end: win.end }, box));
      };
      if (!cues.length || !box) { fallback(); continue; }
      if (occupied.some(other => win.start < other.end && other.start < win.end)) { fallback(); continue; }
      const segments = splitWindowByCues(cues, bounds, win);
      let placed = false;
      for (const segment of segments) {
        // 线性移动段（piece from→to）内字幕位置连续变化，固定贴放必然漂移
        // 甚至压字——回退固定位置；瞬切段已被 instant 边界切开，段内位置恒定。
        const moving = segment.cue?.slice?.pieces?.some(piece => piece.instant == null
          && (piece.from?.x !== piece.to?.x || piece.from?.y !== piece.to?.y)
          && (segment.start ?? 0) < (Number(piece.end) || 0)
          && (Number(piece.start) || 0) <= (segment.end ?? 0));
        const placement = segment.cue && !moving
          ? cueLeftBox(plan, segment.cue, (segment.start + segment.end) / 2) : null;
        if (placement) {
          placed = true;
          cuePlacements.push({ rel: win.rel, ...placement, intervals: [{ start: segment.start, end: segment.end }] });
        } else if (box) {
          fixedPlacements.push(fixedBoxPlacement(win.rel, { start: segment.start, end: segment.end }, box));
        }
      }
      // 段循环已为空隙段与回退段写入 fixed placement；这里只在窗口确实有
      // 段贴上字幕时占用（同屏去重）。
      if (placed) occupied.push(win);
    }
    return mergePlacementIntervals([...cuePlacements, ...fixedPlacements]);
  }

  return Object.freeze({ computeStickerCuePlacements, TARGET_RATIO, GAP_RATIO });
}
