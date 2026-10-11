// ass-canvas-layout: ASS Canvas 预览的纯布局计算。
// 只做数值计算，不触碰 DOM 与 Canvas：文本测量通过注入的 measurer 完成，
// Node 测试可以用假测量器离线验证行切分、锚点与块偏移的正确性。
window.MAWE.register('utils-ass-canvas-layout', function createUtilsModule(dependencies) {
  'use strict';

  const ASS_DEFAULT_PLAY_RES_X = 1920;
  const ASS_DEFAULT_PLAY_RES_Y = 1080;


  // ASS Alignment（数字小键盘布局 1-9）→ 网格坐标。column: 0 左 / 1 中 / 2 右；
  // row 采用屏幕语义：0 上 / 1 中 / 2 下（ASS 1-3 是底行，7-9 是顶行）。
  function assCanvasAlignmentGrid(value) {
    const alignment = Math.min(9, Math.max(1, Math.round(Number(value) || 2)));
    return { column: (alignment - 1) % 3, row: 2 - Math.floor((alignment - 1) / 3) };
  }


  // 事件锚点（PlayRes 原生坐标）：ASS 按对齐方式把文本块的对应边/中心
  // 贴到锚点上。有 \pos/\move 时，锚点就是移动后的绝对坐标——\pos 的
  // 语义正是「事件的锚点落在该坐标」，与边距无关。
  /**
   * @param {{
   *   alignment?: number,
   *   margins?: { left?: number, right?: number, vertical?: number },
   *   playResX?: number,
   *   playResY?: number,
   *   move?: { x?: number, y?: number } | null,
   * }} [options]
   */
  function assCanvasAnchorPoint({ alignment, margins, playResX, playResY, move } = {}) {
    if (move && Number.isFinite(Number(move.x)) && Number.isFinite(Number(move.y))) {
      return { x: Number(move.x), y: Number(move.y) };
    }
    const { column, row } = assCanvasAlignmentGrid(alignment);
    const left = Math.max(0, Number(margins?.left) || 0);
    const right = Math.max(0, Number(margins?.right) || 0);
    const vertical = Math.max(0, Number(margins?.vertical) || 0);
    const width = Math.max(1, Number(playResX) || ASS_DEFAULT_PLAY_RES_X);
    const height = Math.max(1, Number(playResY) || ASS_DEFAULT_PLAY_RES_Y);
    return {
      x: column === 0 ? left : column === 1 ? width / 2 : width - right,
      y: row === 0 ? vertical : row === 1 ? height / 2 : height - vertical,
    };
  }


  // 单行 x 偏移（相对锚点，绘制时再叠加块的行序号）：左列贴左、中列逐行
  // 居中、右列贴右——与 DOM 预览的 text-align 语义一致。
  function assCanvasLineOffsetX(column, lineWidth) {
    if (column === 1) return -lineWidth / 2;
    return column === 2 ? -lineWidth : 0;
  }


  // 块顶相对锚点的 y 偏移：底行块的底边贴锚点、中行居中、顶行顶边贴锚点。
  function assCanvasBlockTopY(row, blockHeight) {
    if (row === 1) return -blockHeight / 2;
    return row === 2 ? -blockHeight : 0;
  }


  // Chain a secondary track above the nominal single-line box of the track
  // below it. Keep its horizontal alignment/margins, but attach its bottom
  // edge to an absolute anchor: MarginV cannot express this for middle rows
  // and moves in the wrong direction for top rows. As in the existing 1.2 ×
  // font-size model, this does not measure multiline/animated glyph bounds.
  // Do not clamp off-screen anchors: that would overlap the user's main cue.
  /**
   * @param {{ belowAnchor?: { x?: number, y?: number }, belowAlignment?: number,
   *   belowFontSize?: number, alignment?: number,
   *   margins?: { left?: number, right?: number, vertical?: number },
   *   playResX?: number, playResY?: number }} [options]
   */
  function assCanvasStackedAnchor({ belowAnchor, belowAlignment, belowFontSize,
    alignment, margins, playResX, playResY } = {}) {
    const belowRow = assCanvasAlignmentGrid(belowAlignment).row;
    const fontSize = Math.max(1, Number(belowFontSize) || 1);
    const anchor = assCanvasAnchorPoint({ alignment, margins, playResX, playResY });
    anchor.y = Math.round(Number(belowAnchor?.y) || 0)
      - Math.round(1.2 * fontSize) + Math.round((2 - belowRow) * fontSize / 2);
    return { alignment: assCanvasAlignmentGrid(alignment).column + 1, anchor };
  }


  // 把带样式的 run 序列按换行切成行并计算行内 x 偏移。
  // 工程文本中的真实换行就是 ASS 的 \N；run 顺序即阅读顺序。
  // measurer(run, fragment) 由绘制层注入（run 内不同字号/间距宽度不同），
  // 返回 { width, ascent, descent }；行高取行内所有 run 的最大 ascent/descent，
  // 与 CSS line-height: normal 的行盒语义一致。
  // 非空文本中的显式空行（\N\n）按基准 run 的行盒占一行高，与 libass 和
  // 旧 DOM 预览一致；整条文本为空时仍返回单个 0 高行，绘制层直接跳过。
  function assCanvasLayoutLines(runs, measurer) {
    const source = Array.isArray(runs) ? runs : [];
    const hasText = source.some((run) => String(run?.text ?? '').length > 0);
    const lines = [];
    let current = null;
    const pushLine = () => {
      current = { items: [], width: 0, ascent: 0, descent: 0 };
      lines.push(current);
    };
    pushLine();
    source.forEach((run) => {
      String(run?.text ?? '').split('\n').forEach((fragment, index) => {
        if (index > 0) pushLine();
        if (!fragment) return;
        const metrics = measurer ? measurer(run, fragment) : {};
        const width = Math.max(0, Number(metrics?.width) || 0);
        const ascent = Math.max(0, Number(metrics?.ascent) || 0);
        const descent = Math.max(0, Number(metrics?.descent) || 0);
        current.items.push({ run, text: fragment, x: current.width, width, ascent, descent });
        current.width += width;
        current.ascent = Math.max(current.ascent, ascent);
        current.descent = Math.max(current.descent, descent);
      });
    });
    if (hasText) {
      const probeRun = source.find((run) => String(run?.text ?? '').length > 0) || source[0];
      const blank = measurer ? measurer(probeRun, ' ') : {};
      lines.forEach((line) => {
        if (!line.items.length) {
          line.ascent = Math.max(0, Number(blank?.ascent) || 0);
          line.descent = Math.max(0, Number(blank?.descent) || 0);
        }
      });
    }
    let blockWidth = 0;
    let blockHeight = 0;
    lines.forEach((line) => {
      blockWidth = Math.max(blockWidth, line.width);
      blockHeight += line.ascent + line.descent;
    });
    return { lines, blockWidth, blockHeight };
  }


  // Geometry is shared by export and playback. Browser font metrics are injected;
  // the deterministic fallback keeps portable utility/Node consumers DOM-free.
  function assMeasureStackRun(style, fontSize, run, text, measure) {
    const scale = (run.size === 'small' ? style.smallTextScale : run.size === 'large' ? style.largeTextScale : 1)
      * (run.emphasized ? style.emphasisScale : 1) * (run.comment ? style.commentScale || 1 : 1);
    const size = Math.max(1, scale === 1 ? fontSize : Math.round(fontSize * scale));
    const measured = measure?.(style, fontSize, run, text);
    return measured || { width: [...text].length * size + Math.max(0, (text.length - 1) * (style.spacing || 0)),
      ascent: size * 0.8, descent: size * 0.2 };
  }

  function assStackWrappedRuns(item, width, measure) {
    const result = [];
    let used = 0;
    const append = (run, text) => {
      const last = result[result.length - 1];
      if (last && last.__source === run) last.text += text;
      else result.push({ ...run, text, __source: run });
    };
    for (const run of item.runs) {
      for (const fragment of String(run.text || '').split(/(\n)/u)) {
        if (fragment === '\n') { append(run, fragment); used = 0; continue; }
        if (!fragment) continue;
        const metrics = assMeasureStackRun(item.style, item.fontSize, run, fragment, measure);
        if (used + metrics.width <= width) { append(run, fragment); used += metrics.width; continue; }
        for (const character of [...fragment]) {
          const advance = assMeasureStackRun(item.style, item.fontSize, run, character, measure).width;
          if (used > 0 && used + advance > width) { append(run, '\n'); used = 0; }
          append(run, character); used += advance;
        }
      }
    }
    return result.map(({ __source, ...run }) => run);
  }

  function assStackCueBounds(item, start, end, alignment, measure, profile) {
    const elapsed = (time) => Math.max(0, time - item.start);
    const styles = [start, Math.max(start, end - 0.001)].map(time => {
      const state = dependencies.assStackAnimationState(profile, elapsed(time), item.end - item.start);
      return state.transformProgress === null ? { ...item.style, fontSize: item.fontSize }
        : dependencies.assPreviewStyleAt({ ...item.style, fontSize: item.fontSize }, profile.animations.t.tags, state.transformProgress, { nativeFontSize: true });
    });
    const targets = dependencies.assTransformStyleTargets(profile?.animations?.t?.tags || '');
    const max = (key, fallback) => Math.max(...styles.map(style => Number(style[key] ?? fallback)));
    const style = { ...item.style, fontSize: max('fontSize', item.fontSize), spacing: max('spacing', 0),
      outline: max('outline', 0), shadow: max('shadow', 0) };
    const variants = [style];
    if (targets.bold !== undefined) variants.push({ ...style, bold: Boolean(targets.bold) });
    if (targets.italic !== undefined) variants.push({ ...style, italic: Boolean(targets.italic) });
    variants.push({ ...style, bold: Boolean(targets.bold ?? style.bold), italic: Boolean(targets.italic ?? style.italic) });
    let inkPadding = 0;
    const layouts = variants.map(probe => assCanvasLayoutLines(item.runs,
      (run, text) => {
        const metrics = assMeasureStackRun(probe, style.fontSize, run, text, measure);
        inkPadding = Math.max(inkPadding, Number(metrics.inkPadding) || 0);
        return metrics;
      }));
    const width = Math.max(...layouts.map(layout => layout.blockWidth));
    const height = Math.max(...layouts.map(layout => layout.blockHeight));
    const grid = assCanvasAlignmentGrid(alignment);
    const padding = Math.ceil(style.outline + style.shadow + Math.max(2, style.fontSize * 0.08) + inkPadding);
    const left = assCanvasLineOffsetX(grid.column, width) - padding;
    const top = assCanvasBlockTopY(grid.row, height) - padding;
    const rect = { left, top, right: left + width + padding * 2, bottom: top + height + padding * 2 };
    const sx = max('scaleX', 100) / 100;
    const sy = max('scaleY', 100) / 100;
    const angleA = Number(styles[0].angle) || 0;
    const angleB = Number(styles[1].angle) || 0;
    if (angleA !== angleB) {
      // A sweep may reach its largest box between endpoints (e.g. 0 -> 180).
      const radius = Math.max(...[rect.left, rect.right].flatMap(x =>
        [rect.top, rect.bottom].map(y => Math.hypot(x, y))));
      const reach = radius * Math.max(sx, sy);
      return { left: -reach, right: reach, top: -reach, bottom: reach };
    }
    const angle = angleA * Math.PI / 180;
    // Include both rotation conventions: Canvas and libass use different screen
    // signs. This envelope is conservative for either 2D renderer.
    const corners = [angle, -angle].flatMap(a => [rect.left, rect.right].flatMap(x =>
      [rect.top, rect.bottom].flatMap(y => [
        { x: sx * (x * Math.cos(a) - y * Math.sin(a)), y: sy * (x * Math.sin(a) + y * Math.cos(a)) },
        { x: sx * x * Math.cos(a) - sy * y * Math.sin(a), y: sx * x * Math.sin(a) + sy * y * Math.cos(a) },
      ])));
    return { left: Math.min(...corners.map(p => p.x)), right: Math.max(...corners.map(p => p.x)),
      top: Math.min(...corners.map(p => p.y)), bottom: Math.max(...corners.map(p => p.y)) };
  }

  function assStackRawRoot(slice, time) {
    const root = slice.root;
    if (root?.role === 'main' && slice.profile?.animations?.move?.enabled) {
      const state = dependencies.assStackAnimationState(slice.profile, time - root.start, root.end - root.start);
      return { x: state.moveX, y: state.moveY };
    }
    return slice.baseAnchor;
  }

  function assStackRootPosition(slice, time) {
    const point = assStackRawRoot(slice, time);
    const r = slice.scale;
    const box = slice.box;
    const padding = slice.padding;
    return { x: Math.min(slice.width - padding - box.right * r, Math.max(padding - box.left * r, point.x)),
      y: Math.min(slice.height - padding - box.bottom * r, Math.max(padding - box.top * r, point.y)) };
  }

  function assStackMotionPieces(slice) {
    const breaks = new Set([slice.start, slice.end]);
    const move = slice.profile?.animations?.move;
    if (slice.root?.role === 'main' && move?.enabled) {
      const a = slice.root.start + move.t1;
      const b = move.t1 === 0 && move.t2 === 0 ? slice.root.end : slice.root.start + move.t2;
      if (a === b) {
        const instant = b;
        return [{ start: slice.start, end: slice.end, instant,
          from: assStackRootPosition(slice, slice.start), to: assStackRootPosition(slice, Math.max(slice.start, slice.end - 0.001)) }];
      }
      for (const time of [a, b]) if (time > slice.start && time < slice.end) breaks.add(Math.round(time / 10) * 10);
      if (b > a) {
        for (const [axis, lower, upper] of [
          ['x', slice.padding - slice.box.left * slice.scale, slice.width - slice.padding - slice.box.right * slice.scale],
          ['y', slice.padding - slice.box.top * slice.scale, slice.height - slice.padding - slice.box.bottom * slice.scale],
        ]) {
          const from = move[`${axis}1`], to = move[`${axis}2`];
          if (from === to) continue;
          for (const limit of [lower, upper]) {
            const amount = (Number(limit) - from) / (to - from);
            const time = Math.round((a + amount * (b - a)) / 10) * 10;
            if (amount > 0 && amount < 1 && time > slice.start && time < slice.end) breaks.add(time);
          }
        }
      }
    }
    const points = [...breaks].filter(time => time >= slice.start && time <= slice.end).sort((a, b) => a - b);
    return points.slice(0, -1).map((start, index) => ({ start, end: points[index + 1],
      from: assStackRootPosition(slice, start), to: assStackRootPosition(slice, points[index + 1]), instant: null }));
  }

  /** @param {any} options */
  function assCreateStackPlan({ items, profile, width = 1920, height = 1080, measure } = {}) {
    const events = new Map();
    const queue = (time, item, active) => {
      if (!events.has(time)) events.set(time, []);
      events.get(time).push({ item, active });
    };
    for (const item of items || []) { queue(item.start, item, true); queue(item.end, item, false); }
    const times = [...events.keys()].sort((a, b) => a - b);
    const active = new Set();
    const slices = [];
    const diagnostics = [];
    const prepared = new Map();
    // Consume every transform tag. Raw ASS accepts far more geometry than the
    // portable Canvas renderer can prove; ambiguities cannot silently crop.
    const transformText = profile?.animations?.t?.enabled ? profile.animations.t.tags || '' : '';
    const seen = new Set();
    const unsupported = transformText.split('\\').slice(1).some(part => {
      const tag = /^(fs|fscx|fscy|fsp|frz|fr|bord|shad|b|i|u|s)(-?\d+(?:\.\d+)?)\s*$/iu.exec(part);
      if (tag) {
        const name = tag[1].toLowerCase(), value = Number(tag[2]);
        const limit = { fs: [1, 512], fscx: [0, 1000], fscy: [0, 1000], fsp: [-100, 100], frz: [-360, 360], fr: [-360, 360], bord: [0, 100], shad: [0, 100], b: [0, 1], i: [0, 1], u: [0, 1], s: [0, 1] }[name];
        const key = name === 'fr' ? 'frz' : name;
        const invalid = seen.has(key) || value < limit[0] || value > limit[1];
        seen.add(key); return invalid;
      }
      return !/^(?:[1234]?c&H[0-9a-f]{6,8}&?|(?:alpha|[1234]a)&H[0-9a-f]{2}&?)\s*$/iu.test(part);
    }) || (transformText.trim() && !transformText.trim().startsWith('\\'));
    for (let i = 0; i < times.length - 1; i += 1) {
      const start = times[i], end = times[i + 1];
      for (const event of events.get(start)) { if (event.active) active.add(event.item); else active.delete(event.item); }
      if (!active.size || end <= start) continue;
      const ordered = [...active].sort((a, b) => ({ main: 0, extension: 1, overlay: 2 }[a.role]
        - { main: 0, extension: 1, overlay: 2 }[b.role]) || b.start - a.start || a.index - b.index);
      const root = ordered[0];
      const baseAnchor = assCanvasAnchorPoint({ alignment: root.style.alignment,
        margins: { left: root.style.marginL, right: root.style.marginR, vertical: root.style.marginV },
        playResX: width, playResY: height });
      const slice = { start, end, root, profile, baseAnchor, width, height, padding: Math.max(2, Math.round(height / 135)),
        scale: 1, items: [], pieces: [], box: { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity }, legacy: false, diagnostic: '' };
      if (ordered.length === 1 && root.role === 'main') {
        slice.legacy = true; slice.items = [{ ...root, alignment: root.style.alignment, offset: { x: 0, y: 0 } }];
        slice.pieces = [{ start, end }]; slices.push(slice); continue;
      }
      if (ordered.some(item => item.style.spacing < 0)
        || (profile?.animations?.t?.enabled && dependencies.assTransformStyleTargets(transformText).spacing < 0)) {
        slice.diagnostic = 'ASS 自动堆叠无法可靠排布负字距；请将样式及变换的字距改为非负值后导出。';
        diagnostics.push({ start, end, message: slice.diagnostic }); slices.push(slice); continue;
      }
      if (unsupported) {
        slice.diagnostic = 'ASS 自动堆叠不支持此方案的 3D 透视或自定义几何标签；请关闭这些变换后导出。';
        diagnostics.push({ start, end, message: slice.diagnostic }); slices.push(slice); continue;
      }
      let previous = null;
      for (const item of ordered) {
        let cue = prepared.get(item);
        if (!cue) {
          cue = { ...item, runs: assStackWrappedRuns(item, Math.max(1, width - item.style.marginL - item.style.marginR), measure) };
          prepared.set(item, cue);
        }
        const alignment = item === root ? item.style.alignment : assCanvasAlignmentGrid(item.style.alignment).column + 1;
        const rect = assStackCueBounds(cue, start, end, alignment, measure, profile);
        const ownAnchor = assCanvasAnchorPoint({ alignment, margins: { left: item.style.marginL, right: item.style.marginR }, playResX: width, playResY: height });
        const offset = { x: item === root ? 0 : ownAnchor.x - baseAnchor.x,
          y: previous ? previous.top - Math.max(2, Math.round(previous.fontSize * 0.2)) - rect.bottom : 0 };
        const placement = { ...cue, alignment, offset, rect };
        slice.items.push(placement);
        const world = { left: offset.x + rect.left, right: offset.x + rect.right,
          top: offset.y + rect.top, bottom: offset.y + rect.bottom };
        for (const key of ['left', 'top']) slice.box[key] = Math.min(slice.box[key], world[key]);
        for (const key of ['right', 'bottom']) slice.box[key] = Math.max(slice.box[key], world[key]);
        previous = { ...world, fontSize: cue.fontSize };
      }
      slice.scale = Math.min(1, (width - slice.padding * 2) / Math.max(1, slice.box.right - slice.box.left),
        (height - slice.padding * 2) / Math.max(1, slice.box.bottom - slice.box.top));
      const smallest = Math.min(...ordered.flatMap(item => {
        const values = [start, end].map(time => {
          const state = dependencies.assStackAnimationState(profile, time - item.start, item.end - item.start);
          return state.transformProgress === null ? item.fontSize
            : dependencies.assPreviewStyleAt({ ...item.style, fontSize: item.fontSize }, profile.animations.t.tags,
              state.transformProgress, { nativeFontSize: true }).fontSize;
        });
        return item.runs.filter(run => run.text).map(run => Math.max(1, Math.round(Math.min(...values)
          * (run.size === 'small' ? item.style.smallTextScale : run.size === 'large' ? item.style.largeTextScale : 1)
          * (run.emphasized ? item.style.emphasisScale : 1) * (run.comment ? item.style.commentScale : 1))));
      }));
      if (!Number.isFinite(slice.scale) || slice.scale <= 0 || (slice.scale < 1 && smallest * slice.scale < Math.min(smallest, 8 * height / 1080))) {
        slice.diagnostic = 'ASS 字幕组过大，缩放后字号低于可读范围；请减少同时显示的文字或调小样式后重试。';
        diagnostics.push({ start, end, message: slice.diagnostic });
      }
      slice.pieces = assStackMotionPieces(slice);
      slices.push(slice);
    }
    const cueKey = item => item.segment || `${item.role}:${item.index}:${item.start}:${item.end}`;
    const groupedCues = new Set(slices.filter(slice => !slice.legacy).flatMap(slice => slice.items.map(cueKey)));
    for (const slice of slices) for (const item of slice.items) item.sharedStackCue = groupedCues.has(cueKey(item));
    return { slices, diagnostics, width, height };
  }

  function assStackFrame(plan, timeMs) {
    const slices = plan?.slices || [];
    let lo = 0, hi = slices.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (slices[mid].start <= timeMs) lo = mid + 1; else hi = mid; }
    const slice = slices[lo - 1];
    if (!slice || timeMs >= slice.end) return { items: [], diagnostic: '' };
    if (slice.diagnostic) return { items: [], diagnostic: slice.diagnostic };
    if (slice.legacy) return { items: slice.items.map(item => ({ ...item, scale: 1, legacy: true })), diagnostic: '' };
    const piece = slice.pieces.find(piece => timeMs < piece.end) || slice.pieces[slice.pieces.length - 1];
    const amount = piece.instant !== null && piece.instant !== undefined
      ? (piece.instant === piece.start ? Math.min(1, Math.max(0, timeMs - piece.instant)) : (timeMs > piece.instant ? 1 : 0))
      : Math.min(1, Math.max(0, (timeMs - piece.start) / Math.max(1, piece.end - piece.start)));
    const root = { x: piece.from.x + (piece.to.x - piece.from.x) * amount,
      y: piece.from.y + (piece.to.y - piece.from.y) * amount };
    return { items: slice.items.map(item => ({ ...item, scale: slice.scale,
      anchor: { x: root.x + item.offset.x * slice.scale, y: root.y + item.offset.y * slice.scale } })), diagnostic: '' };
  }


  return Object.freeze({
    assCanvasAlignmentGrid,
    assCanvasAnchorPoint,
    assCanvasBlockTopY,
    assCanvasStackedAnchor,
    assCanvasLineOffsetX,
    assCanvasLayoutLines,
    assCreateStackPlan,
    assStackFrame,
  });
});
