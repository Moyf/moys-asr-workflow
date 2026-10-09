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
    return size * (run?.emphasized ? style.emphasisScale : 1);
  }


  function runNativeSize(track, run) {
    const scale = runSizeScale(track.style, run);
    return Math.max(1, Math.round((Number(track.nativeFontSize) || 1) * scale));
  }


  // \fsp 在样式字号（原生 PlayRes 像素）上定义，换算到绘制字号同比例；
  // ctx.letterSpacing 不可用时退回逐字符排版（放弃连字，与旧 CSS
  // letter-spacing 预览的行为一致）。
  function spacingInfo(track, run, ratio) {
    const nativeSize = runNativeSize(track, run);
    const cssSize = nativeSize * ratio;
    const spacingCss = nativeSize > 0
      ? (Number(track.style.spacing) || 0) * cssSize / nativeSize : 0;
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
      return {
        width,
        ascent: Number(metrics.fontBoundingBoxAscent) || info.cssSize * 0.8,
        descent: Number(metrics.fontBoundingBoxDescent) || info.cssSize * 0.2,
      };
    };
  }


  function runFillColor(style, run) {
    if (run?.speakerColor) return run.speakerColor;
    if (run?.emphasized && style.emphasisStyle === 'text') return style.emphasisColor;
    return style.primaryColor;
  }


  function runDecorColor(style, run) {
    if (run?.speakerColor) return run.speakerColor;
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
        Boolean(item.run.struck), item.run.size || '', item.run.speakerColor || '', quantize(item.width)]),
      quantize(ratio), fontFamilyCss(style.fontName), Boolean(style.bold), Boolean(style.italic),
      Math.round(Number(track.nativeFontSize) || 1),
      quantize(style.spacing), quantize(style.outline), style.outlineColor,
      quantize(style.outlineOpacity ?? 100), style.backColor, quantize(style.backOpacity ?? 100),
      quantize(style.shadow), Math.round(Number(style.borderStyle) || 1),
      style.primaryColor, style.emphasisColor, style.emphasisStyle || 'text',
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
    // 锚定轨（副字幕/叠加轨）可以覆盖样式自带的 Alignment：叠加轨链在
    // 副字幕上方时沿用副字幕的对齐（与导出侧锚定继承一致）。
    const alignmentValue = track.alignment ?? style.alignment;
    const grid = u.assCanvasAlignmentGrid(alignmentValue);
    const anchor = u.assCanvasAnchorPoint({
      alignment: alignmentValue,
      margins: track.margins,
      playResX,
      playResY,
      move: style.__assMove || null,
    });
    // 渲染参数快照（e2e 断言用）：行/字段尺寸与最终落色直接取自绘制路径，
    // 保证测试看到的就是画布实际消费的值。
    const borderBox = Math.round(Number(style.borderStyle) || 1) === 3;
    const record = {
      skipped: false,
      opacity: alpha,
      nativeFontSize: Number(track.nativeFontSize) || 0,
      alignment: alignmentValue,
      anchor: { ...anchor },
      margins: { ...(track.margins || {}) },
      blockWidth: layout.blockWidth,
      blockHeight: layout.blockHeight,
      speaker: track.speaker ? { ...track.speaker } : null,
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
          emphasisStroke: item.run.emphasized && style.emphasisStyle === 'stroke' && !borderBox
            ? style.emphasisColor : '',
          emphasisBox: item.run.emphasized && style.emphasisStyle === 'stroke' && borderBox
            ? style.emphasisColor : '',
        })),
      })),
    };
    ctx.save();
    ctx.globalAlpha = alpha;
    // 变换顺序 translate → scale → rotate 与 DOM 预览 transform 列表
    //（translate/anchor、scale、rotateZ）一致，旋转/缩放围绕锚点。
    ctx.translate(anchor.x, anchor.y);
    // \frx/\fry 是 3D 透视旋转，Canvas 2D 无法真正表达；旧 CSS 预览用
    // perspective 近似，这里以旋转后的正交投影等价式（rotateX 压缩纵向、
    // rotateY 压缩横向，>90° 自然镜像）保留动画表现，仅缺少斜切效果。
    const rotationX = Number(style.rotationX) || 0;
    const rotationY = Number(style.rotationY) || 0;
    const foreshortenX = rotationY ? Math.cos(rotationY * Math.PI / 180) : 1;
    const foreshortenY = rotationX ? Math.cos(rotationX * Math.PI / 180) : 1;
    ctx.scale(
      Math.max(0, Number(style.scaleX ?? 100)) / 100 * foreshortenX,
      Math.max(0, Number(style.scaleY ?? 100)) / 100 * foreshortenY,
    );
    const angle = Number(style.angle) || 0;
    if (angle) ctx.rotate(angle * Math.PI / 180);
    let lineTop = u.assCanvasBlockTopY(grid.row, layout.blockHeight);
    layout.lines.forEach((line) => {
      if (line.width > 0 && line.ascent + line.descent > 0) {
        const x = u.assCanvasLineOffsetX(grid.column, line.width);
        const entry = rasterizeLine(lineCacheKey(track, line, ratio), line, track, ratio);
        ctx.drawImage(entry.bitmap, x - entry.pad, lineTop - entry.pad);
      }
      lineTop += line.ascent + line.descent;
    });
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
    const tracks = Array.isArray(payload?.tracks) ? payload.tracks : [];
    // 快照槽位与 payload 顺序一致（不可见轨占位 skipped），e2e 断言可按
    // 主/副/叠加轨固定下标取值。
    const records = [];
    tracks.forEach((track) => {
      if (track?.visible === false) {
        records.push({ skipped: true, opacity: 0 });
        return;
      }
      records.push(drawTrack(track, width, height));
    });
    lastRender = { playResX: width, playResY: height, tracks: records };
  }


  function hide() {
    if (canvasEl) canvasEl.hidden = true;
  }


  function clearCaches() {
    lineCache.clear();
    fontRatioCache.clear();
  }

  document.fonts?.addEventListener?.('loadingdone', clearCaches);

  global.MaweAssCanvas = Object.freeze({
    render,
    hide,
    clearCaches,
    // 渲染参数快照：e2e 迁移断言用（测试看到的就是画布实际消费的值）。
    get lastRender() { return lastRender; },
  });
})(typeof window !== 'undefined' ? window : globalThis);
