// ass-canvas-layout: ASS Canvas 预览的纯布局计算。
// 只做数值计算，不触碰 DOM 与 Canvas：文本测量通过注入的 measurer 完成，
// Node 测试可以用假测量器离线验证行切分、锚点与块偏移的正确性。
export function createUtilsModule(dependencies) {

  'use strict';

  const ASS_DEFAULT_PLAY_RES_X = 1920;
  const ASS_DEFAULT_PLAY_RES_Y = 1080;

  // ASS 单句原地震动（`!!文字!!` 标记）：ASS 一条事件只能有一个定位标签，
  // 震动只能在导出时把一句拆成多条短 Dialogue，各自写 \pos。预览按同一
  // 确定性模式逐帧偏移锚点，保证与导出逐片一致。间隔取 60ms（6 厘秒），
  // 恰好落在 ASS 时间精度网格上；振幅随 PlayRes 高度缩放，四个相位构成
  // 对角往复，从第一片起就偏离基准位置。
  const ASS_SHAKE_INTERVAL_MS = 60;
  const ASS_SHAKE_PATTERN = Object.freeze([[1, 1], [-1, -1], [1, -1], [-1, 1]]);

  function assShakeAmplitude(playResY) {
    return Math.max(2, Math.round((Number(playResY) || ASS_DEFAULT_PLAY_RES_Y) / 216));
  }

  function assShakeOffsetFor(elapsedMs, amplitude) {
    const step = Math.max(0, Math.floor((Number(elapsedMs) || 0) / ASS_SHAKE_INTERVAL_MS));
    const [signX, signY] = ASS_SHAKE_PATTERN[step % ASS_SHAKE_PATTERN.length];
    const amount = Math.max(0, Number(amplitude) || 0);
    return { x: signX * amount, y: signY * amount };
  }

  // 排布分片内某时刻的组根坐标：piece 可能带 instant（瞬时切变）或
  // from→to 线性移动（整组位移 / 方案移动动画）。assStackFrame 与导出的
  // 震动取样共用这一份公式，保证预览与导出基准位置一致。
  function assStackPieceRootAt(piece, timeMs) {
    const amount = piece.instant !== null && piece.instant !== undefined
      ? (piece.instant === piece.start ? Math.min(1, Math.max(0, timeMs - piece.instant)) : (timeMs > piece.instant ? 1 : 0))
      : Math.min(1, Math.max(0, (timeMs - piece.start) / Math.max(1, piece.end - piece.start)));
    return { x: piece.from.x + (piece.to.x - piece.from.x) * amount,
      y: piece.from.y + (piece.to.y - piece.from.y) * amount };
  }


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
    const scale = item.cueScale || 1;
    if (scale !== 1) item = { ...item, fontSize: item.fontSize * scale,
      style: { ...item.style, spacing: item.style.spacing * scale } };
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
      const state = dependencies.assStackAnimationState(profile, elapsed(time), item.end - item.start,
        { pop: item.pop || null });
      const style = state.transformProgress === null ? { ...item.style, fontSize: item.fontSize }
        : dependencies.assPreviewStyleAt({ ...item.style, fontSize: item.fontSize }, profile.animations.t.tags, state.transformProgress, { nativeFontSize: true, popScale: state.popScale });
      const scale = item.cueScale || 1;
      // 入场放大的最大状态（片起点）计入包围盒，避免堆叠避碰按落定字号预留。
      const fontSize = style.fontSize * scale;
      return { ...style, fontSize, scaleX: style.scaleX * (state.popScale || 1),
        scaleY: style.scaleY * (state.popScale || 1), spacing: style.spacing * scale,
        outline: style.outline * scale, shadow: style.shadow * scale };
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
    // Pop followed by a custom axis transform can have an interior extremum.
    // Its value is a convex combination of the current pop scale and target:
    // bound both endpoints of that combination instead of sampling the curve.
    const popAtStart = dependencies.assStackAnimationState(profile, elapsed(start), item.end - item.start,
      { pop: item.pop || null }).popScale || 1;
    const axisMax = key => popAtStart > 1 && profile?.animations?.t?.enabled && targets[key] !== undefined
      ? Math.max(max(key, 100), item.style[key] * popAtStart, targets[key]) : max(key, 100);
    const sx = axisMax('scaleX') / 100;
    const sy = axisMax('scaleY') / 100;
    const angleA = Number(styles[0].angle) || 0;
    const angleB = Number(styles[1].angle) || 0;
    const from = Math.min(angleA, angleB) * Math.PI / 180;
    const to = Math.max(angleA, angleB) * Math.PI / 180;
    // Bound the actual rotation sweep, including extrema between endpoints.
    // A full-circle radius wrongly rejects a fixed cue that only turns 10°.
    // Keep both screen signs and both scale/rotation orders conservative.
    const extrema = (cosine, sine, start, end) => {
      const at = angle => cosine * Math.cos(angle) + sine * Math.sin(angle);
      const values = [at(start), at(end)];
      const critical = Math.atan2(sine, cosine);
      for (let k = Math.ceil((start - critical) / Math.PI); k <= Math.floor((end - critical) / Math.PI); k += 1) {
        values.push(at(critical + k * Math.PI));
      }
      return values;
    };
    const horizontal = [], vertical = [];
    for (const [start, end] of [[from, to], [-to, -from]]) {
      for (const x of [rect.left, rect.right]) for (const y of [rect.top, rect.bottom]) {
        horizontal.push(...extrema(sx * x, -sx * y, start, end), ...extrema(sx * x, -sy * y, start, end));
        vertical.push(...extrema(sy * y, sy * x, start, end), ...extrema(sy * y, sx * x, start, end));
      }
    }
    return { left: Math.min(...horizontal), right: Math.max(...horizontal),
      top: Math.min(...vertical), bottom: Math.max(...vertical) };
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
    for (const raw of items || []) {
      // 主字幕与叠加字幕共用逐句 assOverride（scale/pos）；扩展轨是固定层，
      // 仍不消费逐句覆盖。手动定位句成为独立 ASS 事件：不参与整组适配、
      // 避碰与方案移动；只有缩放的句继续留在自动排布内。
      const override = raw.role === 'main' || raw.role === 'overlay'
        ? dependencies.normalizeAssOverride(raw.segment?.assOverride) : undefined;
      const item = { ...raw, cueScale: override?.scale || 1,
        ...(override ? { assOverride: override, manual: Boolean(override.pos) } : {}) };
      queue(item.start, item, true); queue(item.end, item, false);
    }
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
      const all = [...active].sort((a, b) => ({ main: 0, extension: 1, overlay: 2 }[a.role]
        - { main: 0, extension: 1, overlay: 2 }[b.role]) || b.start - a.start || a.index - b.index);
      // Explicit pos cues are independent ASS events: no group fit, collision
      // avoidance, profile move or automatic translation may change their anchor.
      const ordered = all.filter(item => !item.manual);
      const manual = all.filter(item => item.manual).map(item => {
        const runs = assStackWrappedRuns(item, Math.max(1, width - item.style.marginL - item.style.marginR), measure);
        return { ...item, runs, alignment: item.style.alignment,
          offset: { ...item.assOverride.pos }, absolute: true, sharedStackCue: true };
      });
      // If every main cue is manual, an overlay keeps its automatic style
      // anchor; a fixed extension must not become the overlay's moving root.
      const root = (manual.length && !ordered.some(item => item.role === 'main')
        ? ordered.find(item => item.role !== 'extension') : null) || ordered[0] || manual[0];
      const baseAnchor = assCanvasAnchorPoint({ alignment: root.style.alignment,
        margins: { left: root.style.marginL, right: root.style.marginR, vertical: root.style.marginV },
        playResX: width, playResY: height });
      const slice = { start, end, root, profile, baseAnchor, width, height, padding: Math.max(2, Math.round(height / 135)),
        scale: 1, items: [...manual], pieces: [], box: { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity }, legacy: false, diagnostic: '' };
      if (!ordered.length || (ordered.length === 1 && root.role === 'main')) {
        slice.legacy = true;
        // Legacy 震动句在导出中带 \q2 与预折行 runs：这里与手动定位句同
        // 规则预折行，让 Canvas 预览与导出使用同一份换行结果。
        if (ordered.length) slice.items.push({ ...root, alignment: root.style.alignment, offset: { x: 0, y: 0 },
          ...(root.shake || root.cueScale !== 1 ? { runs: assStackWrappedRuns(root, Math.max(1, width - root.style.marginL - root.style.marginR), measure) } : {}) });
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
      // 副字幕轨内的碰撞堆叠基准：同一排布切片内多条副字幕互相错开
      //（模拟 libass 同层碰撞避免），第一条仍严格落在其样式预设位置。
      let extensionPrevious = null;
      for (const item of ordered) {
        let cue = prepared.get(item);
        if (!cue) {
          cue = { ...item, runs: assStackWrappedRuns(item, Math.max(1, width - item.style.marginL - item.style.marginR), measure) };
          prepared.set(item, cue);
        }
        // 副字幕是固定层：位置完全跟随其样式预设（对齐 + MarginV，即主字幕
        // 下方的常规位置），不参与向上堆叠、不改变主/叠加字幕的堆叠链，
        // 也不计入整组包围盒（「空间不足整组移入」不搬动固定层）。
        const fixed = item.role === 'extension';
        const alignment = item === root || fixed ? item.style.alignment
          : assCanvasAlignmentGrid(item.style.alignment).column + 1;
        const rect = assStackCueBounds(cue, start, end, alignment, measure, profile);
        if (fixed && (rect.right - rect.left > width - slice.padding * 2
          || rect.bottom - rect.top > height - slice.padding * 2)) {
          slice.diagnostic = 'ASS 固定副字幕超出可用画面；请减少同时显示的文字或调小副字幕样式后重试。';
          break;
        }
        const ownAnchor = assCanvasAnchorPoint({ alignment,
          margins: { left: item.style.marginL, right: item.style.marginR,
            vertical: fixed ? item.style.marginV : undefined },
          playResX: width, playResY: height });
        // 副字幕是固定层：位置完全跟随其样式预设（对齐 + MarginV，即主字幕
        // 下方的常规位置），不参与向上堆叠、不跟随主/叠加字幕的排布平移与
        // 移动动画（与 libass 对无 \move 的不同层字幕的原生行为一致）。
        // 同轨多条副字幕之间保留 libass 式碰撞错开；固定层不计入整组包围盒，
        // 主字幕与叠加字幕的防出画移入也不被副字幕的位置限制。
        const fixedAnchor = fixed ? (() => {
          const anchor = extensionPrevious
            ? { x: ownAnchor.x, y: extensionPrevious.top
              - Math.max(2, Math.round(extensionPrevious.fontSize * 0.2)) - rect.bottom }
            : ownAnchor;
          return {
            x: Math.min(Math.max(anchor.x, slice.padding - rect.left), width - slice.padding - rect.right),
            y: Math.min(Math.max(anchor.y, slice.padding - rect.top), height - slice.padding - rect.bottom),
          };
        })() : null;
        if (fixed && extensionPrevious && fixedAnchor.y + rect.bottom > extensionPrevious.top
          - Math.max(2, Math.round(extensionPrevious.fontSize * 0.2)) + 1e-7) {
          slice.diagnostic = 'ASS 固定副字幕无法在画面中同时容纳；请减少重叠字幕或调小副字幕样式后重试。';
          break;
        }
        const offset = fixed ? { x: fixedAnchor.x, y: fixedAnchor.y }
          : item === root ? { x: 0, y: 0 }
          : { x: ownAnchor.x - baseAnchor.x,
            y: previous ? previous.top - Math.max(2, Math.round(previous.fontSize * 0.2)) - rect.bottom : 0 };
        const placement = { ...cue, alignment, offset, rect, absolute: fixed };
        slice.items.push(placement);
        if (fixed) {
          extensionPrevious = { top: fixedAnchor.y + rect.top, fontSize: cue.fontSize };
          continue;
        }
        const world = { left: offset.x + rect.left, right: offset.x + rect.right,
          top: offset.y + rect.top, bottom: offset.y + rect.bottom };
        for (const key of ['left', 'top']) slice.box[key] = Math.min(slice.box[key], world[key]);
        for (const key of ['right', 'bottom']) slice.box[key] = Math.max(slice.box[key], world[key]);
        previous = { ...world, fontSize: cue.fontSize * (cue.cueScale || 1) };
      }
      if (slice.diagnostic) {
        diagnostics.push({ start, end, message: slice.diagnostic }); slices.push(slice); continue;
      }
      slice.scale = Math.min(1, (width - slice.padding * 2) / Math.max(1, slice.box.right - slice.box.left),
        (height - slice.padding * 2) / Math.max(1, slice.box.bottom - slice.box.top));
      const smallest = Math.min(...ordered.filter(item => item.role !== 'extension').flatMap(item => {
        const values = [start, end].map(time => {
          const state = dependencies.assStackAnimationState(profile, time - item.start, item.end - item.start);
          return state.transformProgress === null ? item.fontSize * (item.cueScale || 1)
            : dependencies.assPreviewStyleAt({ ...item.style, fontSize: item.fontSize }, profile.animations.t.tags,
              state.transformProgress, { nativeFontSize: true }).fontSize * (item.cueScale || 1);
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
    for (const slice of slices) for (const item of slice.items) item.sharedStackCue = item.manual || item.cueScale !== 1 || groupedCues.has(cueKey(item));
    return { slices, diagnostics, width, height };
  }

  function assStackFrame(plan, timeMs) {
    const slices = plan?.slices || [];
    let lo = 0, hi = slices.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (slices[mid].start <= timeMs) lo = mid + 1; else hi = mid; }
    const slice = slices[lo - 1];
    if (!slice || timeMs >= slice.end) return { items: [], diagnostic: '' };
    if (slice.diagnostic) return { items: [], diagnostic: slice.diagnostic };
    const shakeOffset = item => item.shake
      ? { shakeOffset: assShakeOffsetFor(timeMs - item.start, assShakeAmplitude(slice.height) * (item.absolute ? 1 : slice.scale) * item.cueScale) } : {};
    if (slice.legacy) return { items: slice.items.map(item => ({ ...item, scale: 1, legacy: true,
      ...(item.manual ? { anchor: { ...item.offset } } : {}), ...shakeOffset(item) })), diagnostic: '' };
    const piece = slice.pieces.find(piece => timeMs < piece.end) || slice.pieces[slice.pieces.length - 1];
    const root = assStackPieceRootAt(piece, timeMs);
    return { items: slice.items.map(item => {
      // 固定层（副字幕）的锚点是绝对坐标：不随主字幕的排布平移或移动动画。
      if (item.absolute) return { ...item, scale: 1, anchor: { x: item.offset.x, y: item.offset.y }, ...shakeOffset(item) };
      return { ...item, scale: slice.scale,
        anchor: { x: root.x + item.offset.x * slice.scale, y: root.y + item.offset.y * slice.scale }, ...shakeOffset(item) };
    }), diagnostic: '' };
  }


  return Object.freeze({
    ASS_SHAKE_INTERVAL_MS,
    assCanvasAlignmentGrid,
    assCanvasAnchorPoint,
    assCanvasBlockTopY,
    assCanvasStackedAnchor,
    assCanvasLineOffsetX,
    assCanvasLayoutLines,
    assCreateStackPlan,
    assStackFrame,
    assShakeAmplitude,
    assShakeOffsetFor,
    assStackPieceRootAt,
  });
}
