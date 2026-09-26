// lottie: private helpers; dependencies are injected by editor-utils.js.
window.MAWE.register('utils-lottie', function createUtilsModule(dependencies) {
  'use strict';
  const { DEFAULT_PREVIEW_GEOMETRY, normalizePreviewGeometry } = dependencies;


  // === Lottie 动态字幕导出 ===
  // 生成器只负责无外部资源的 Lottie JSON；server-editor 再把它放进
  // dotLottie（.lottie）容器。这样时间码、字体、颜色和定位都能在 Node
  // 中单测，服务器不需要理解字幕工程的业务结构。
  const LOTTIE_DEFAULT_FPS = 30;

  const LOTTIE_DEFAULT_WIDTH = 1920;

  const LOTTIE_DEFAULT_HEIGHT = 1080;

  const LOTTIE_DEFAULT_FONT_FAMILY = 'Arial';

  const LOTTIE_DEFAULT_HIGHLIGHT_COLOR = '#ffd34d';

  const LOTTIE_FONT_FAMILY_ALIASES = Object.freeze({
    default: LOTTIE_DEFAULT_FONT_FAMILY,
    yahei: 'Microsoft YaHei',
    hei: 'SimHei',
    song: 'SimSun',
    sans: 'Arial',
  });


  function lottieAnimatedProperty(value) {
    return { a: 0, k: value };
  }


  function normalizeLottieFps(value) {
    const raw = String(value ?? '').trim();
    let fps = 0;
    if (/^\d+(?:\.\d+)?\/\d+(?:\.\d+)?$/u.test(raw)) {
      const [numerator, denominator] = raw.split('/').map(Number);
      fps = denominator > 0 ? numerator / denominator : 0;
    } else {
      fps = Number(raw);
    }
    return Number.isFinite(fps) && fps > 0 && fps <= 240 ? fps : LOTTIE_DEFAULT_FPS;
  }


  function normalizeLottieCanvasDimension(value, fallback) {
    const dimension = Math.round(Number(value));
    return Number.isFinite(dimension) && dimension >= 1 && dimension <= 16384
      ? dimension : fallback;
  }


  function lottieColor(value, fallback) {
    const source = typeof value === 'string' && /^#[0-9a-f]{6}$/iu.test(value)
      ? value : fallback;
    return [0, 2, 4].map((offset) => Number.parseInt(source.slice(1 + offset, 3 + offset), 16) / 255);
  }


  function normalizeLottieFontFamily(value) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw || raw === 'default') return LOTTIE_DEFAULT_FONT_FAMILY;
    return LOTTIE_FONT_FAMILY_ALIASES[raw] || raw;
  }


  function normalizeLottieRenderMode(value) {
    return value === 'glyph' ? 'glyph' : 'text';
  }


  function lottieTextUnits(value) {
    return Array.from(String(value || '').replace(/\r\n?/gu, '\n'));
  }


  function findLottieTextUnits(haystack, needle, fromIndex) {
    if (!needle.length) return -1;
    const start = Math.max(0, Math.min(haystack.length, Number(fromIndex) || 0));
    outer: for (let index = start; index <= haystack.length - needle.length; index++) {
      for (let offset = 0; offset < needle.length; offset++) {
        if (haystack[index + offset] !== needle[offset]) continue outer;
      }
      return index;
    }
    return -1;
  }


  function lottieSelectorKeyframes(entries, finalFrame, valueKey) {
    const byFrame = new Map();
    entries.forEach((entry) => {
      if (!Number.isFinite(entry.frame)) return;
      byFrame.set(Math.max(0, Math.round(entry.frame)), Math.max(0, Math.round(entry[valueKey])));
    });
    if (Number.isFinite(finalFrame)) byFrame.set(Math.max(0, Math.round(finalFrame)), 0);
    return [...byFrame.entries()].sort((left, right) => left[0] - right[0]).map(([frame, value]) => ({
      t: frame,
      s: [value],
      h: 1,
    }));
  }


  function buildLottieTextAnimator(
    segment, textUnits, cueStartFrame, cueEndFrame, fps, highlightColor,
  ) {
    const items = Array.isArray(segment?.items) ? segment.items : [];
    let ranges = [];
    let cursor = 0;
    items.forEach((item) => {
      const itemText = String(item?.text || '').replace(/\r\n?/gu, '\n');
      const itemUnits = lottieTextUnits(itemText);
      if (!itemUnits.length) return;
      const startIndex = findLottieTextUnits(textUnits, itemUnits, cursor);
      if (startIndex < 0) return;
      const endIndex = startIndex + itemUnits.length;
      const rawStart = Number(item?.start);
      const itemFrame = Number.isFinite(rawStart)
        ? Math.max(cueStartFrame, Math.min(cueEndFrame, Math.floor(rawStart / 1000 * fps)))
        : cueStartFrame;
      ranges.push({ frame: itemFrame, start: startIndex, end: endIndex });
      cursor = endIndex;
    });
    // SRT 和被文字处理过的工程可能没有可用的 items。仍然生成逐字高亮，
    // 将字符按句段时长均匀分配，避免导出的动态字幕退化为静态字幕。
    if (!ranges.length) {
      const frameSpan = Math.max(1, cueEndFrame - cueStartFrame);
      ranges = textUnits.map((_, index) => ({
        frame: cueStartFrame + Math.floor(frameSpan * index / textUnits.length),
        start: index,
        end: index + 1,
      }));
    }

    const first = ranges[0];
    const startEntries = [{ frame: cueStartFrame, start: first.frame > cueStartFrame ? 0 : first.start }];
    const endEntries = [{ frame: cueStartFrame, end: first.frame > cueStartFrame ? 0 : first.end }];
    ranges.slice(first.frame > cueStartFrame ? 0 : 1).forEach((range) => {
      startEntries.push({ frame: range.frame, start: range.start });
      endEntries.push({ frame: range.frame, end: range.end });
    });
    return {
      nm: 'MAW word highlight',
      s: {
        t: 0,
        xe: lottieAnimatedProperty(0),
        ne: lottieAnimatedProperty(0),
        a: lottieAnimatedProperty(100),
        b: 1,
        rn: 0,
        sh: 1,
        sm: lottieAnimatedProperty(100),
        o: lottieAnimatedProperty(0),
        r: 2,
        s: { a: 1, k: lottieSelectorKeyframes(startEntries, cueEndFrame, 'start') },
        e: { a: 1, k: lottieSelectorKeyframes(endEntries, cueEndFrame, 'end') },
      },
      a: {
        fc: lottieAnimatedProperty(highlightColor),
      },
    };
  }


  function buildLottieAnimation(segments, options = {}) {
    const width = normalizeLottieCanvasDimension(options.width, LOTTIE_DEFAULT_WIDTH);
    const height = normalizeLottieCanvasDimension(options.height, LOTTIE_DEFAULT_HEIGHT);
    const fps = normalizeLottieFps(options.fps);
    const source = Array.isArray(segments) ? segments : [];
    const maxSegmentEnd = source.reduce((max, segment) => {
      const end = Number(segment?.end);
      return Number.isFinite(end) ? Math.max(max, end) : max;
    }, 0);
    const requestedDuration = Number(options.durationMs);
    const durationMs = Math.max(
      maxSegmentEnd,
      Number.isFinite(requestedDuration) && requestedDuration > 0 ? requestedDuration : 0,
      1,
    );
    const totalFrames = Math.max(1, Math.ceil(durationMs / 1000 * fps));
    const subtitle = options.subtitle && typeof options.subtitle === 'object' ? options.subtitle : {};
    const geometry = normalizePreviewGeometry(subtitle, DEFAULT_PREVIEW_GEOMETRY);
    const boxWidth = Math.max(1, Math.round(geometry.width * width));
    const boxHeight = Math.max(1, Math.round(geometry.height * height));
    const centerX = Math.round((geometry.x + geometry.width / 2) * width);
    const centerY = Math.round((geometry.y + geometry.height / 2) * height);
    const referenceWidth = Number(options.previewReferenceWidth) > 0
      ? Number(options.previewReferenceWidth) : 960;
    const rawFontSize = Number(subtitle.font_size);
    const fontSize = Math.max(8, Math.min(512, Math.round(
      (Number.isFinite(rawFontSize) && rawFontSize > 0 ? rawFontSize : 18) * width / referenceWidth,
    )));
    const fontFamily = normalizeLottieFontFamily(subtitle.font_family);
    const renderMode = normalizeLottieRenderMode(options.renderMode);
    const baseColor = lottieColor(subtitle.color, '#ffffff');
    const highlightColor = lottieColor(options.highlightColor, LOTTIE_DEFAULT_HIGHLIGHT_COLOR);
    const layers = [];

    source.forEach((segment, index) => {
      if (!segment || segment.disabled) return;
      const text = String(segment.text || '').replace(/\r\n?/gu, '\n');
      const start = Number(segment.start);
      const end = Number(segment.end);
      if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
      const ip = Math.max(0, Math.min(totalFrames - 1, Math.floor(start / 1000 * fps)));
      const op = Math.max(ip + 1, Math.min(totalFrames, Math.ceil(end / 1000 * fps)));
      const textUnits = lottieTextUnits(text);
      const animator = buildLottieTextAnimator(
        segment, textUnits, ip, op, fps, highlightColor,
      );
      const document = {
        f: fontFamily,
        fc: baseColor,
        sc: [0, 0, 0],
        sw: 0,
        of: false,
        s: fontSize,
        lh: Math.round(fontSize * 1.25),
        sz: [boxWidth, boxHeight],
        ps: [-Math.round(boxWidth / 2), -Math.round(boxHeight / 2)],
        t: text.replace(/\n/gu, '\r'),
        j: 2,
        tr: 0,
        ls: 0,
      };
      layers.push({
        ddd: 0,
        ind: layers.length + 1,
        ty: 5,
        nm: `MAW 字幕 ${index + 1}`,
        sr: 1,
        ks: {
          o: lottieAnimatedProperty(100),
          r: lottieAnimatedProperty(0),
          p: lottieAnimatedProperty([centerX, centerY, 0]),
          a: lottieAnimatedProperty([0, 0, 0]),
          s: lottieAnimatedProperty([100, 100, 100]),
        },
        ao: 0,
        ip,
        op,
        st: 0,
        bm: 0,
        t: {
          d: { k: [{ s: document, t: 0 }] },
          a: animator ? [animator] : [],
          m: { a: lottieAnimatedProperty([0, 0]) },
          p: {},
        },
      });
    });

    return {
      v: '5.7.0',
      fr: fps,
      ip: 0,
      op: totalFrames,
      w: width,
      h: height,
      nm: 'MAW Dynamic Captions',
      ddd: 0,
      assets: [],
      fonts: { list: [{ fName: fontFamily, fFamily: fontFamily, fStyle: 'Regular', ascent: 75 }] },
      layers,
      meta: {
        g: 'moys-asr-workflow',
        d: 'MAW dynamic captions',
        renderMode,
        fontFamily,
        highlightColor: options.highlightColor || LOTTIE_DEFAULT_HIGHLIGHT_COLOR,
      },
    };
  }

  return Object.freeze({ LOTTIE_DEFAULT_HEIGHT, LOTTIE_DEFAULT_WIDTH, buildLottieAnimation, findLottieTextUnits, lottieTextUnits, normalizeLottieCanvasDimension, normalizeLottieFontFamily, normalizeLottieFps });
});
