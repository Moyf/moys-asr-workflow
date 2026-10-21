// ASS 预览的 Canvas 合成层。
//
// DOM/CSS 预览（-webkit-text-stroke）的描边是逐 span 居中描边：半透明描边
// 在 run 交界处叠加出接缝，且在显示分辨率上直接描边，边缘不如 libass 的
// 「原生分辨率渲染再缩小」平滑。本模块按 libass 的绘制顺序（阴影 → 描边 →
// 填充）在 PlayRes 原生分辨率的画布上光栅化，整行一次描边消除接缝，再由
// CSS 缩小到舞台大小获得抗锯齿边缘。
//
// 复刻范围锁定在 MAW 导出会产生的 tag 集合：fad/fade（合成透明度）、
// \move（锚点位移）、\t 的 fs/fscx/fscy/frz/bord/shad/颜色插值、
// BorderStyle 1/3、\fsp、强调/下划线/删除线 run。\frx/\fry 的 3D 透视
// 是 Canvas 2D 做不到的，以轴向透视缩短近似保留动画表现（见 drawTrack）。
//
// 性能模型：行位图按 (文本 run + 样式快照) 缓存，fad/fade 只改合成
// globalAlpha 不触发重光栅；播放时每帧成本是几次 drawImage，量级远低于
// 视频解码。缓存溢出整体清空，由 document.fonts 载入事件主动失效。
(function initMaweAssCanvas(global) {
  'use strict';

  const LINE_CACHE_MAX = 160;
  const lineCache = new Map();
  const fontRatioCache = new Map();
  let canvasEl = null;
  let ctx = null;
  let measureCtx = null;
  let letterSpacingSupported = null;
  let resolvedSansFamily = '';
  let lastRender = null;


  function ensureCanvas() {
    if (canvasEl) return canvasEl;
    const host = global.MaweDom?.overlayEl;
    if (!host) return null;
    canvasEl = document.createElement('canvas');
    canvasEl.className = 'ass-preview-canvas';
    canvasEl.hidden = true;
    host.prepend(canvasEl);
    ctx = canvasEl.getContext('2d');
    return canvasEl;
  }


  function ensureMeasureCtx() {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    return measureCtx;
  }


  function supportsLetterSpacing() {
    if (letterSpacingSupported === null) {
      letterSpacingSupported = 'letterSpacing' in ensureMeasureCtx();
    }
    return letterSpacingSupported;
  }


  // subtitleFontFamilyCss 可能返回 var(--font-sans) 兜底；ctx.font 不解析
  // CSS 变量，这里解析成具体字体族列表。
  function fontFamilyCss(fontName) {
    let family = global.MaweAppearance?.subtitleFontFamilyCss?.(fontName) || '';
    if (family.includes('var(--font-sans)')) {
      if (!resolvedSansFamily) {
        resolvedSansFamily = (getComputedStyle(document.documentElement)
          .getPropertyValue('--font-sans') || '').trim() || 'sans-serif';
      }
      family = family.replace('var(--font-sans)', resolvedSansFamily);
    }
    return family;
  }


  function fontSpec(style, cssSize) {
    const weight = style.bold ? '700' : '400';
    const italic = style.italic ? 'italic ' : '';
    return `${italic}${weight} ${cssSize}px ${fontFamilyCss(style.fontName)}`.trim();
  }


  // ASS 字号按「字形 ascent+descent 高度」解释，ctx.font 按 em 解析；
  // 用 fontBoundingBox 量出两者的比值，绘制字号 = 目标字号 × 比值，使
  // 实际字形高度精确等于样式字号（与 libass 的解释一致）。
  // 无 fontBoundingBox 的旧浏览器退回 DOM 行盒探测（含行距的近似值）。
  function fontBoxRatio(style) {
    const key = JSON.stringify([fontFamilyCss(style.fontName), Boolean(style.bold), Boolean(style.italic)]);
    if (fontRatioCache.has(key)) return fontRatioCache.get(key);
    let ratio = 0;
    try {
      const mctx = ensureMeasureCtx();
      mctx.font = fontSpec(style, 100);
      const metrics = mctx.measureText('Mg');
      const box = (Number(metrics.fontBoundingBoxAscent) || 0)
        + (Number(metrics.fontBoundingBoxDescent) || 0);
      if (box > 0) ratio = 100 / box;
    } catch {
      ratio = 0;
    }
    if (!Number.isFinite(ratio) || ratio <= 0) {
      ratio = global.MaweAssPreview?.fontScale?.(style) || 1;
    }
    fontRatioCache.set(key, ratio);
    return ratio;
  }


  function runSizeScale(style, run) {
    const size = run?.size === 'small' ? style.smallTextScale
      : run?.size === 'large' ? style.largeTextScale : 1;
    return size * (run?.emphasized ? style.emphasisScale : 1) * (run?.comment ? (style.commentScale || 1) : 1);
  }


  function runNativeSize(track, run) {
    const scale = runSizeScale(track.style, run);
    const size = (Number(track.nativeFontSize) || 1) * scale;
    // Stacked plain text inherits the fractional event fs. Proportional runs
    // have an explicit rounded local fs in ASS; solo preview keeps its old rule.
    return Math.max(1, track.fractionalFontSize && scale === 1 ? size : Math.round(size));
  }


  // \fsp is measured in native PlayRes pixels. Stacked drawing preserves that
  // advance independently of the font-box/em conversion; solo keeps its prior
  // approximation for compatibility.
  // ctx.letterSpacing 不可用时退回逐字符排版（放弃连字，与旧 CSS
  // letter-spacing 预览的行为一致）。
  function spacingInfo(track, run, ratio) {
    const nativeSize = runNativeSize(track, run);
    const cssSize = nativeSize * ratio;
    const spacingCss = track.fractionalFontSize ? Number(track.style.spacing) || 0
      : nativeSize > 0 ? (Number(track.style.spacing) || 0) * cssSize / nativeSize : 0;
    return {
      cssSize,
      nativeSize,
      spacingCss,
      perChar: spacingCss !== 0 && !supportsLetterSpacing(),
    };
  }


  function applyItemFont(g, track, run, ratio) {
    const info = spacingInfo(track, run, ratio);
    g.font = fontSpec(track.style, info.cssSize);
    g.letterSpacing = info.perChar || !info.spacingCss ? '0px' : `${info.spacingCss}px`;
    return info;
  }


  // 逐字符模式：前进量 = 字符宽 + 间距；宽度与绘制用同一测量，保证
  // measurer 与 rasterize 不漂移。
  function paintItemText(g, item, x, baseline, info, mode) {
    if (!info.perChar) {
      if (mode === 'stroke') g.strokeText(item.text, x, baseline);
      else g.fillText(item.text, x, baseline);
      return;
    }
    let cursor = x;
    for (const ch of item.text) {
      if (mode === 'stroke') g.strokeText(ch, cursor, baseline);
      else g.fillText(ch, cursor, baseline);
      cursor += g.measureText(ch).width + info.spacingCss;
    }
  }


  function measureItem(g, item, info) {
    if (!info.perChar) return g.measureText(item.text).width;
    let width = 0;
    for (const ch of item.text) width += g.measureText(ch).width + info.spacingCss;
    return width;
  }


  function measurerFor(track, ratio) {
    return (run, text) => {
      const info = spacingInfo(track, run, ratio);
      const g = ensureMeasureCtx();
      g.font = fontSpec(track.style, info.cssSize);
      g.letterSpacing = info.perChar || !info.spacingCss ? '0px' : `${info.spacingCss}px`;
      const metrics = g.measureText(text);
      const width = info.perChar
        ? [...text].reduce((sum, ch) => sum + g.measureText(ch).width + info.spacingCss, 0)
        : metrics.width;
      let ascent = Number(metrics.fontBoundingBoxAscent) || info.cssSize * 0.8;
      let descent = Number(metrics.fontBoundingBoxDescent) || info.cssSize * 0.2;
      // Chromium rounds fontBoundingBox metrics even for fractional CSS fonts.
      // ASS line advance remains the native fs, so retain its continuous height
      // rather than accumulating that rounding error over explicit newlines.
      if (track.fractionalFontSize && runSizeScale(track.style, run) === 1) {
        const boxScale = info.nativeSize / (ascent + descent);
        ascent *= boxScale;
        descent *= boxScale;
      }
      return {
        width,
        ascent,
        descent,
        inkPadding: Math.max(0, Number(metrics.actualBoundingBoxLeft) || 0,
          (Number(metrics.actualBoundingBoxRight) || 0) - width,
          (Number(metrics.actualBoundingBoxAscent) || 0) - ascent,
          (Number(metrics.actualBoundingBoxDescent) || 0) - descent),
      };
    };
  }


  function runFillColor(style, run) {
    if (run?.speakerColor) return run.speakerColor;
    if (run?.comment && style.commentStyle !== 'stroke') return style.commentColor;
    if (run?.emphasized && style.emphasisStyle === 'text') return style.emphasisColor;
    return style.primaryColor;
  }


  function runDecorColor(style, run) {
    if (run?.speakerColor) return run.speakerColor;
    if (run?.comment && style.commentStyle !== 'stroke') return style.commentColor;
    if ((run?.underlined || run?.struck) && run?.emphasized && style.emphasisStyle === 'text') {
      return style.emphasisColor;
    }
    return style.primaryColor;
  }


  function clampOpacityPercent(value) {
    return Math.min(1, Math.max(0, (Number(value) ?? 100) / 100));
  }


  function quantize(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
  }


  function lineCacheKey(track, line, ratio) {
    const style = track.style;
    return JSON.stringify([
      line.items.map((item) => [item.text, Boolean(item.run.emphasized), Boolean(item.run.underlined),
        Boolean(item.run.struck), item.run.size || '', Boolean(item.run.comment),
        item.run.speakerColor || '', quantize(item.width)]),
      quantize(ratio), fontFamilyCss(style.fontName), Boolean(style.bold), Boolean(style.italic),
      Boolean(track.fractionalFontSize), track.fractionalFontSize
        ? Number((Number(track.nativeFontSize) || 1).toFixed(4)) : Math.round(Number(track.nativeFontSize) || 1),
      quantize(style.spacing), quantize(style.outline), style.outlineColor,
      quantize(style.outlineOpacity ?? 100), style.backColor, quantize(style.backOpacity ?? 100),
      quantize(style.shadow), Math.round(Number(style.borderStyle) || 1),
      style.primaryColor, style.emphasisColor, style.emphasisStyle || 'text',
      style.commentColor, style.commentStyle || 'text', style.commentScale,
      Boolean(style.underline), Boolean(style.strikeOut),
      style.smallTextScale, style.largeTextScale, style.emphasisScale,
    ]);
  }


  // 把一行按 libass 顺序光栅化成位图：阴影剪影（描边∪填充，合成时偏移
  // shad）→ 描边层（逐 run strokeText 后作为整层单次 alpha 合成，避免
  // run 交界接缝）→ 填充层。半透明颜色只在层与层合成时生效，层内先以
  // 不透明光栅化，避免同色描边/填充叠加造成 alpha 加深。pad 覆盖描边
  // 外延与阴影偏移，保证右下影子不被位图截断。
  function rasterizeLine(key, line, track, ratio) {
    const cached = lineCache.get(key);
    if (cached) return cached;
    const style = track.style;
    const outline = Math.max(0, Number(style.outline) || 0);
    const shadow = Math.max(0, Number(style.shadow) || 0);
    const borderBox = Math.round(Number(style.borderStyle) || 1) === 3;
    const pad = Math.ceil(outline + shadow + 2);
    const bodyWidth = Math.ceil(line.width);
    const bodyHeight = Math.ceil(line.ascent + line.descent);
    const bitmap = document.createElement('canvas');
    bitmap.width = Math.max(1, bodyWidth + pad * 2);
    bitmap.height = Math.max(1, bodyHeight + pad * 2);
    const g = bitmap.getContext('2d');
    const baseline = pad + line.ascent;

    const makeLayer = () => {
      const layer = document.createElement('canvas');
      layer.width = bitmap.width;
      layer.height = bitmap.height;
      return [layer, layer.getContext('2d')];
    };
    const eachItem = (target, fn) => line.items.forEach((item) => {
      const info = applyItemFont(target, track, item.run, ratio);
      fn(item, pad + item.x, baseline, info);
    });

    const drawDecorations = (target, colorOf, expand) => {
      line.items.forEach((item) => {
        const underlined = Boolean(style.underline) || Boolean(item.run.underlined);
        const struck = Boolean(style.strikeOut) || Boolean(item.run.struck);
        if (!underlined && !struck) return;
        const info = spacingInfo(track, item.run, ratio);
        const thickness = Math.max(1, info.cssSize * 0.07);
        const x = pad + item.x;
        target.fillStyle = colorOf(item.run);
        if (underlined) {
          target.fillRect(x, baseline + info.cssSize * 0.16 - thickness / 2 - expand,
            item.width, thickness + expand * 2);
        }
        if (struck) {
          target.fillRect(x, baseline - info.cssSize * 0.3 - thickness / 2 - expand,
            item.width, thickness + expand * 2);
        }
      });
    };

    // 阴影层：描边∪填充剪影（含下划线/删除线），偏移 (shad, shad)。
    if (shadow > 0) {
      const [layer, lg] = makeLayer();
      lg.fillStyle = style.backColor;
      lg.strokeStyle = style.backColor;
      if (borderBox) {
        lg.fillRect(pad - outline + shadow, pad - outline + shadow,
          bodyWidth + outline * 2, bodyHeight + outline * 2);
      } else {
        lg.lineJoin = 'round';
        lg.lineCap = 'round';
        lg.miterLimit = 2;
        lg.lineWidth = outline * 2;
        eachItem(lg, (item, x, base, info) => paintItemText(lg, item, x, base, info, 'stroke'));
        eachItem(lg, (item, x, base, info) => paintItemText(lg, item, x, base, info, 'fill'));
        drawDecorations(lg, () => style.backColor, 0);
      }
      g.globalAlpha = clampOpacityPercent(style.backOpacity);
      // 剪影在层内按原位光栅，合成时整体偏移 (shad, shad)；BorderStyle 3
      // 的影框则在层内直接按偏移绘制（pad 已含 shadow，不会被截断）。
      g.drawImage(layer, borderBox ? 0 : shadow, borderBox ? 0 : shadow);
      g.globalAlpha = 1;
    }

    if (borderBox) {
      // BorderStyle 3：行框（OutlineColour）替代描边，文字只填充。
      g.globalAlpha = clampOpacityPercent(style.outlineOpacity);
      g.fillStyle = style.outlineColor;
      g.fillRect(pad - outline, pad - outline, bodyWidth + outline * 2, bodyHeight + outline * 2);
      g.globalAlpha = 1;
    } else if (outline > 0) {
      // 描边层：整行一次 stroke；强调描边 run 在主描边后补强调色
      //（两者同宽，颜色替换而非叠加）。下划线/删除线外扩 Outline，
      // 对应 libass 把装饰并入轮廓再描边的行为。
      const [layer, lg] = makeLayer();
      lg.lineJoin = 'round';
      lg.lineCap = 'round';
      lg.miterLimit = 2;
      lg.lineWidth = outline * 2;
      lg.strokeStyle = style.outlineColor;
      eachItem(lg, (item, x, base, info) => paintItemText(lg, item, x, base, info, 'stroke'));
      drawDecorations(lg, () => style.outlineColor, outline);
      if (style.emphasisStyle === 'stroke') {
        lg.strokeStyle = style.emphasisColor;
        line.items.forEach((item) => {
          if (!item.run.emphasized) return;
          const info = applyItemFont(lg, track, item.run, ratio);
          paintItemText(lg, item, pad + item.x, baseline, info, 'stroke');
        });
      }
      if (style.commentStyle === 'stroke') {
        lg.strokeStyle = style.commentColor;
        line.items.forEach((item) => {
          if (!item.run.comment) return;
          const info = applyItemFont(lg, track, item.run, ratio);
          paintItemText(lg, item, pad + item.x, baseline, info, 'stroke');
        });
      }
      g.globalAlpha = clampOpacityPercent(style.outlineOpacity);
      g.drawImage(layer, 0, 0);
      g.globalAlpha = 1;
    }

    // 填充层：BorderStyle 3 的强调色块 → 文字 → 装饰线（覆盖在文字上，
    // 与 CSS text-decoration 的视觉一致）。
    line.items.forEach((item) => {
      const info = applyItemFont(g, track, item.run, ratio);
      const x = pad + item.x;
      if (borderBox && item.run.emphasized && style.emphasisStyle === 'stroke') {
        g.globalAlpha = clampOpacityPercent(style.outlineOpacity);
        g.fillStyle = style.emphasisColor;
        g.fillRect(x, baseline - item.ascent, item.width, item.ascent + item.descent);
        g.globalAlpha = 1;
      }
      if (borderBox && item.run.comment && style.commentStyle === 'stroke') {
        g.globalAlpha = clampOpacityPercent(style.outlineOpacity);
        g.fillStyle = style.commentColor;
        g.fillRect(x, baseline - item.ascent, item.width, item.ascent + item.descent);
        g.globalAlpha = 1;
      }
      g.fillStyle = runFillColor(style, item.run);
      paintItemText(g, item, x, baseline, info, 'fill');
    });
    drawDecorations(g, (run) => runDecorColor(style, run), 0);

    const entry = { bitmap, pad };
    if (lineCache.size >= LINE_CACHE_MAX) lineCache.clear();
    lineCache.set(key, entry);
    return entry;
  }


  function drawTrack(track, playResX, playResY) {
    const u = global.AsrEditorUtils;
    const style = track.style || {};
    const animation = track.animation || {};
    const fade = Number.isFinite(Number(animation.opacity)) ? Number(animation.opacity) : 1;
    const alpha = Math.max(0, Math.min(1,
      fade * (1 - Math.min(255, Math.max(0, Number(style.alpha) || 0)) / 255)));
    if (alpha <= 0) return { skipped: true, opacity: alpha };
    const ratio = fontBoxRatio(style);
    const runs = Array.isArray(track.runs) ? track.runs : [];
    const speaker = track.speaker?.text
      ? [{ text: String(track.speaker.text), emphasized: false, underlined: false,
        struck: false, size: null, speakerColor: track.speaker.color }, ...runs]
      : runs;
    const layout = u.assCanvasLayoutLines(speaker, measurerFor(track, ratio));
    if (!layout.blockHeight) return { skipped: true, opacity: alpha };
    // Secondary tracks override the vertical attachment while preserving
    // their horizontal alignment, matching the exported an/pos tags.
    const alignmentValue = track.alignment ?? style.alignment;
    const grid = u.assCanvasAlignmentGrid(alignmentValue);
    const anchor = u.assCanvasAnchorPoint({
      alignment: alignmentValue,
      margins: track.margins,
      playResX,
      playResY,
      move: track.anchor || style.__assMove || null,
    });
    // 原地震动：预览按导出同一模式逐帧偏移绘制与命中包围盒；record.anchor
    // 保留基准锚点，逐句定位检查器与拖动以基准为准。
    const shakeOffset = track.shakeOffset;
    const drawAnchor = shakeOffset ? { x: anchor.x + shakeOffset.x, y: anchor.y + shakeOffset.y } : anchor;
    // 渲染参数快照（e2e 断言用）：行/字段尺寸与最终落色直接取自绘制路径，
    // 保证测试看到的就是画布实际消费的值。
    const borderBox = Math.round(Number(style.borderStyle) || 1) === 3;
    const record = {
      skipped: false,
      role: track.role || '',
      cueId: track.cueId ?? null,
      opacity: alpha,
      nativeFontSize: Number(track.nativeFontSize) || 0,
      alignment: alignmentValue,
      anchor: { ...anchor },
      margins: { ...(track.margins || {}) },
      blockWidth: layout.blockWidth,
      blockHeight: layout.blockHeight,
      speaker: track.speaker ? { ...track.speaker } : (runs.some(run => run.speakerColor)
        ? { text: runs.filter(run => run.speakerColor).map(run => run.text).join(''), color: runs.find(run => run.speakerColor).speakerColor } : null),
      lines: layout.lines.map((line) => ({
        width: line.width,
        ascent: line.ascent,
        descent: line.descent,
        items: line.items.map((item) => ({
          text: item.text,
          x: item.x,
          width: item.width,
          cssSize: spacingInfo(track, item.run, ratio).cssSize,
          fill: runFillColor(style, item.run),
          decorColor: runDecorColor(style, item.run),
        underlined: Boolean(style.underline) || Boolean(item.run.underlined),
        struck: Boolean(style.strikeOut) || Boolean(item.run.struck),
        emphasized: Boolean(item.run.emphasized),
        size: item.run.size || '',
        comment: Boolean(item.run.comment),
          emphasisStroke: item.run.emphasized && style.emphasisStyle === 'stroke' && !borderBox
            ? style.emphasisColor : '',
          emphasisBox: item.run.emphasized && style.emphasisStyle === 'stroke' && borderBox
            ? style.emphasisColor : '',
        })),
      })),
    };
    ctx.save();
    ctx.globalAlpha = alpha;
    // translate → ASS-sign rotation → scale: glyphs are scaled before the
    // final rotation, matching libass for anisotropic scale and 2D angles.
    ctx.translate(drawAnchor.x, drawAnchor.y);
    // \frx/\fry 是 3D 透视旋转，Canvas 2D 无法真正表达；旧 CSS 预览用
    // perspective 近似，这里以旋转后的正交投影等价式（rotateX 压缩纵向、
    // rotateY 压缩横向，>90° 自然镜像）保留动画表现，仅缺少斜切效果。
    const rotationX = Number(style.rotationX) || 0;
    const rotationY = Number(style.rotationY) || 0;
    const foreshortenX = rotationY ? Math.cos(rotationY * Math.PI / 180) : 1;
    const foreshortenY = rotationX ? Math.cos(rotationX * Math.PI / 180) : 1;
    const angle = Number(style.angle) || 0;
    // 放大出现：围绕锚点的入场缩放（animation.popScale 由导出同一公式插值，
    // 落定后恒为 1），等价 libass 在 origin 上施加 \fscx\fscy 的行为。
    const popScale = Math.max(0, Number(animation.popScale) || 1);
    // libass rotates the already-scaled glyph coordinates, with counterclockwise
    // positive ASS angles. Matrix order matters for nonuniform scale factors.
    if (angle) ctx.rotate(-angle * Math.PI / 180);
    ctx.scale(
      Math.max(0, Number(style.scaleX ?? 100)) / 100 * foreshortenX * popScale,
      Math.max(0, Number(style.scaleY ?? 100)) / 100 * foreshortenY * popScale,
    );
    let lineTop = u.assCanvasBlockTopY(grid.row, layout.blockHeight);
    layout.lines.forEach((line) => {
      if (line.width > 0 && line.ascent + line.descent > 0) {
        const x = u.assCanvasLineOffsetX(grid.column, line.width);
        const entry = rasterizeLine(lineCacheKey(track, line, ratio), line, track, ratio);
        ctx.drawImage(entry.bitmap, x - entry.pad, lineTop - entry.pad);
      }
      lineTop += line.ascent + line.descent;
    });
    // Hit geometry follows the same 2D transform used for the pixels.
    const pad = Math.ceil((Number(style.outline) || 0) + (Number(style.shadow) || 0) + 2);
    const left = u.assCanvasLineOffsetX(grid.column, layout.blockWidth) - pad;
    const top = u.assCanvasBlockTopY(grid.row, layout.blockHeight) - pad;
    const sx = Math.max(0, Number(style.scaleX ?? 100)) / 100 * foreshortenX * popScale;
    const sy = Math.max(0, Number(style.scaleY ?? 100)) / 100 * foreshortenY * popScale;
    const theta = -angle * Math.PI / 180;
    // Automatic stacking can attach an upper cue by its bottom edge even
    // when the global style uses a top/centre anchor. Re-express its base
    // point using the global attachment before the cue becomes manual.
    const positionGrid = u.assCanvasAlignmentGrid(style.alignment);
    const anchorDx = (positionGrid.column - grid.column) * layout.blockWidth / 2;
    const anchorDy = (positionGrid.row - grid.row) * layout.blockHeight / 2;
    record.positionAnchor = {
      x: anchor.x + anchorDx * sx * Math.cos(theta) - anchorDy * sy * Math.sin(theta),
      y: anchor.y + anchorDx * sx * Math.sin(theta) + anchorDy * sy * Math.cos(theta),
    };
    const corners = [left, left + layout.blockWidth + 2 * pad].flatMap(x =>
      [top, top + layout.blockHeight + 2 * pad].map(y => ({
        x: drawAnchor.x + x * sx * Math.cos(theta) - y * sy * Math.sin(theta),
        y: drawAnchor.y + x * sx * Math.sin(theta) + y * sy * Math.cos(theta),
      })));
    record.bounds = { left: Math.min(...corners.map(p => p.x)), right: Math.max(...corners.map(p => p.x)),
      top: Math.min(...corners.map(p => p.y)), bottom: Math.max(...corners.map(p => p.y)) };
    ctx.restore();
    return record;
  }


  function render(payload) {
    const canvas = ensureCanvas();
    if (!canvas || !ctx) return;
    const width = Math.max(2, Math.round(Number(payload?.playResX) || 1920));
    const height = Math.max(2, Math.round(Number(payload?.playResY) || 1080));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    ctx.clearRect(0, 0, width, height);
    canvas.hidden = false;
    const layer = { main: 0, extension: 1, overlay: 2 };
    const tracks = Array.isArray(payload?.tracks) ? [...payload.tracks]
      .sort((a, b) => (layer[a?.role] ?? 0) - (layer[b?.role] ?? 0)) : [];
    // 按 ASS 层序绘制，手动定位只改变布局，不改变叠放顺序；同轨保持稳定顺序。
    // 检查指定字幕时用 role + cueId 定位，不假定主/副/叠加轨固定下标。
    const records = [];
    tracks.forEach((track) => {
      if (track?.visible === false) {
        records.push({ skipped: true, opacity: 0 });
        return;
      }
      records.push(drawTrack(track, width, height));
    });
    lastRender = { playResX: width, playResY: height, tracks: records };
    global.MaweAssCuePosition?.sync();
  }


  // 样式管理窗的样例预览：复用主预览的光栅管线（描边/底框/阴影观感与
  // 视频预览一致），在给定画布上居中绘制单行样例。无动画/边距/锚定；
  // style.fontSize 即样例画布上的字形高度（ascent+descent 语义）。
  function renderSample(canvasEl, style, text) {
    if (!canvasEl || canvasEl.tagName !== 'CANVAS') return;
    const g = canvasEl.getContext('2d');
    if (!g) return;
    const safeStyle = style || {};
    const ratio = fontBoxRatio(safeStyle);
    const track = { style: safeStyle, nativeFontSize: Math.max(1, Number(safeStyle.fontSize) || 24) };
    const runs = [{ text: String(text ?? ''), emphasized: false, underlined: false,
      struck: false, size: null }];
    const u = global.AsrEditorUtils;
    const layout = u.assCanvasLayoutLines(runs, measurerFor(track, ratio));
    const dpr = Math.max(1, Math.min(3, Number(global.devicePixelRatio) || 1));
    const margin = 6;
    if (!layout.blockHeight) {
      canvasEl.width = dpr * 2;
      canvasEl.height = dpr * 2;
      canvasEl.style.width = '2px';
      canvasEl.style.height = '2px';
      g.clearRect(0, 0, canvasEl.width, canvasEl.height);
      return;
    }
    const entry = rasterizeLine(lineCacheKey(track, layout.lines[0], ratio), layout.lines[0], track, ratio);
    const scaleX = Math.max(0, Number(safeStyle.scaleX ?? 100)) / 100;
    const scaleY = Math.max(0, Number(safeStyle.scaleY ?? 100)) / 100;
    const angle = (Number(safeStyle.angle) || 0) * Math.PI / 180;
    const cos = Math.abs(Math.cos(angle));
    const sin = Math.abs(Math.sin(angle));
    // Size the canvas for the transformed bitmap, including outline/shadow.
    const cssWidth = Math.ceil(scaleX * (entry.bitmap.width * cos + entry.bitmap.height * sin)) + margin * 2;
    const cssHeight = Math.ceil(scaleY * (entry.bitmap.width * sin + entry.bitmap.height * cos)) + margin * 2;
    canvasEl.width = Math.max(1, Math.round(cssWidth * dpr));
    canvasEl.height = Math.max(1, Math.round(cssHeight * dpr));
    canvasEl.style.width = `${cssWidth}px`;
    canvasEl.style.height = `${cssHeight}px`;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cssWidth, cssHeight);
    g.save();
    g.translate(cssWidth / 2, cssHeight / 2);
    g.scale(scaleX, scaleY);
    if (angle) g.rotate(angle);
    g.drawImage(entry.bitmap, -layout.blockWidth / 2 - entry.pad, -layout.blockHeight / 2 - entry.pad);
    g.restore();
  }


  function hide() {
    if (canvasEl) canvasEl.hidden = true;
  }


  const stackMetricsCache = new Map();
  function measureRun(style, nativeFontSize, run, text) {
    const key = JSON.stringify([style.fontName, style.bold, style.italic, nativeFontSize,
      style.spacing, style.smallTextScale, style.largeTextScale, style.emphasisScale, style.commentScale, run, text]);
    if (stackMetricsCache.has(key)) return stackMetricsCache.get(key);
    const measured = measurerFor({ style, nativeFontSize, fractionalFontSize: true }, fontBoxRatio(style))(run, text);
    if (stackMetricsCache.size >= 4096) stackMetricsCache.delete(stackMetricsCache.keys().next().value);
    stackMetricsCache.set(key, measured);
    return measured;
  }

  function clearCaches() {
    stackMetricsCache.clear();
    lineCache.clear();
    fontRatioCache.clear();
  }

  document.fonts?.addEventListener?.('loadingdone', clearCaches);

  global.MaweAssCanvas = Object.freeze({
    render,
    renderSample,
    measureRun,
    hide,
    clearCaches,
    // 渲染参数快照：e2e 迁移断言用（测试看到的就是画布实际消费的值）。
    get lastRender() { return lastRender; },
  });
})(typeof window !== 'undefined' ? window : globalThis);
