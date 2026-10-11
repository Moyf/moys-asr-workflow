// ass-style: private helpers; dependencies are injected by editor-utils.js.
export function createUtilsModule(dependencies) {
  'use strict';
  const { getNavigator, cloneJsonValue } = dependencies;


  // ASS 默认字体按操作系统选择：Arial 对中文没有合适的字形回退，
  // 中文系统下默认字体应直接落到系统自带的 CJK 无衬线字体。
  function assDefaultFontFamily() {
    const nav = getNavigator();
    const source = `${nav?.platform || ''} ${nav?.userAgent || ''}`.toLowerCase();
    if (/win/.test(source)) return 'Microsoft YaHei';
    if (/\bmac|iphone|ipad/.test(source)) return 'PingFang SC';
    return 'Noto Sans CJK SC';
  }

  const ASS_DEFAULT_FONT_FAMILY = assDefaultFontFamily();

  const ASS_DEFAULT_PREVIEW_FONT_SIZE = 18;

  const ASS_AUTO_FONT_SIZE_1080P = 72;

  // Fullscreen preview doubles the CSS size; Subtitle Edit calibration maps
  // that 36px default preview to ASS 72 at 1080p, hence the 4x ratio here.
  const ASS_PREVIEW_TO_ASS_SCALE = ASS_AUTO_FONT_SIZE_1080P / ASS_DEFAULT_PREVIEW_FONT_SIZE;

  const ASS_DEFAULT_COLOR = '#ffffff';

  const ASS_DEFAULT_PLAY_RES_X = 1920;

  const ASS_DEFAULT_PLAY_RES_Y = 1080;

  const ASS_REFERENCE_PLAY_RES_Y = 1080;

  const ASS_COLOR_STYLE_NAMES = Object.freeze(['yellow', 'green', 'red', 'purple', 'blue']);

  // The editor injects window.ASR_EDITOR_PALETTE from maw/colors.py before
  // this module runs. Keep a small fallback so the utility remains usable in
  // standalone tests and integrations that do not render the full template.
  const ASS_FALLBACK_COLOR_PALETTE = Object.freeze([
    Object.freeze({ name: 'yellow', value: '#c4a019' }),
    Object.freeze({ name: 'green', value: '#66bb6a' }),
    Object.freeze({ name: 'red', value: '#f07f6f' }),
    Object.freeze({ name: 'purple', value: '#bf89e6' }),
    Object.freeze({ name: 'blue', value: '#61a7fa' }),
  ]);

  const ASS_STYLE_FORMAT = 'Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding';

  const ASS_EVENT_FORMAT = 'Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text';


  const ASS_STYLE_LIBRARY_SCHEMA = 'moy.asr.ass_styles.v1';

  const ASS_STYLE_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/u;

  const ASS_STYLE_LIBRARY_MAX_NAME_LENGTH = 80;

  const ASS_STYLE_LIBRARY_MAX_FONT_LENGTH = 128;

  const ASS_STYLE_LIBRARY_MAX_TRANSFORM_LENGTH = 512;

  const ASS_COLOR_STYLE_VALUES = Object.freeze(['text', 'speaker', 'stroke', 'none']);

  // Markers are editor syntax only; the ASS event contains override tags instead.
  function assMarkedRanges(source, marker) {
    const width = marker.length;
    const wordMarker = ['_', '-', '+'].includes(marker[0]);
    const ranges = [];
    let cursor = 0;
    while (cursor < source.length) {
      if (!source.startsWith(marker, cursor)
        || source[cursor - 1] === marker[0] || source[cursor + width] === marker[0]
        || (wordMarker && /[a-z0-9]/iu.test(source[cursor - 1] || ''))) {
        cursor += 1;
        continue;
      }
      let end = source.indexOf(marker, cursor + width);
      // Skip a different delimiter width (e.g. ** inside a *...* pair).
      while (end >= 0 && (source[end - 1] === marker[0] || source[end + width] === marker[0])) {
        end = source.indexOf(marker, end + width);
      }
      if (end <= cursor + width || source[end - 1] === marker[0] || source[end + width] === marker[0]
        || (wordMarker && (/[a-z0-9]/iu.test(source[end + width] || '')
          || source.slice(cursor + width, end).includes('\n')))) {
        cursor += width;
        continue;
      }
      ranges.push({ start: cursor, end, width });
      cursor = end + width;
    }
    return ranges;
  }

  function assMarkedRuns(text, syntax, includeUnderline, options = {}) {
    const source = String(text ?? '');
    const markers = new Map();
    const rule = options.assSpecialSymbolRule;
    const widths = rule === 'none' ? [] : rule === 'double' ? [2] : [1, 2];
    const addMarkers = (marker, field) => widths.forEach((width) => {
      assMarkedRanges(source, marker.repeat(width)).forEach(({ start, end }) => {
        markers.set(start, { field, active: true, width });
        markers.set(end, { field, active: false, width });
      });
    });
    if (['single', 'double', 'both'].includes(syntax)) addMarkers('*', 'emphasized');
    if (includeUnderline) {
      if (options.assUnderlineEnabled !== false) addMarkers('_', 'underlined');
      if (options.assStrikeEnabled !== false) addMarkers('~', 'struck');
      if (options.assSmallTextEnabled !== false) addMarkers('-', 'small');
      if (options.assLargeTextEnabled !== false) addMarkers('+', 'large');
      // 注释固定双符号 //：不随单双规则变化，也不接受单 /。
      if (options.assCommentEnabled !== false) {
        assMarkedRanges(source, '//').forEach(({ start, end }) => {
          markers.set(start, { field: 'comment', active: true, width: 2 });
          markers.set(end, { field: 'comment', active: false, width: 2 });
        });
      }
    }
    const runs = [];
    let content = '';
    const active = { emphasized: 0, underlined: 0, struck: 0, small: 0, large: 0, comment: 0 };
    const flush = () => {
      if (content) runs.push({ text: content, emphasized: active.emphasized > 0,
        underlined: active.underlined > 0, struck: active.struck > 0,
        size: active.large > 0 ? 'large' : active.small > 0 ? 'small' : null,
        comment: active.comment > 0 });
      content = '';
    };
    for (let cursor = 0; cursor < source.length;) {
      const marker = markers.get(cursor);
      if (marker) {
        flush();
        active[marker.field] += marker.active ? 1 : -1;
        cursor += marker.width;
      } else {
        content += source[cursor];
        cursor += 1;
      }
    }
    flush();
    if (!runs.length) runs.push({ text: '', emphasized: false, underlined: false, struck: false, size: null, comment: false });
    return runs;
  }

  function assEmphasisRuns(text, syntax) {
    return assMarkedRuns(text, syntax, false).map(({ text, emphasized }) => ({ text, emphasized }));
  }

  function assInlineStyleRuns(text, syntax, options = {}) {
    return assMarkedRuns(text, syntax, true, options);
  }


  function normalizeAssColorStyle(value) {
    if (value === 'underline') return 'text';
    return typeof value === 'string' && ASS_COLOR_STYLE_VALUES.includes(value) ? value : null;
  }


  const ASS_DEFAULT_STYLE = Object.freeze({
    id: 'default',
    name: 'SRT 默认',
    builtin: true,
    fontName: ASS_DEFAULT_FONT_FAMILY,
    fontSize: 86,
    primaryColor: '#ffffff',
    emphasisColor: '#ffd34d',
    emphasisScale: 1.1,
    commentColor: '#9aa4ad',
    commentStyle: 'text',
    commentScale: 1,
    smallTextScale: 0.8,
    largeTextScale: 1.5,
    emphasisStyle: 'text',
    secondaryColor: '#ffffff',
    outlineColor: '#000000',
    backColor: '#000000',
    outlineOpacity: 100,
    backOpacity: 100,
    bold: true,
    italic: false,
    underline: false,
    strikeOut: false,
    scaleX: 100,
    scaleY: 100,
    spacing: 0,
    angle: 0,
    borderStyle: 1,
    outline: 6,
    shadow: 0,
    alignment: 2,
    marginL: 10,
    marginR: 10,
    marginV: 88,
    encoding: 1,
  });

  // 内置参数与维护者的当前配置一致；字体继续按系统选择。
  const ASS_DEFAULT_ASS_STYLE = Object.freeze({
    ...ASS_DEFAULT_STYLE,
    id: 'ass', name: 'ASS 默认样式',
    emphasisColor: '#ffaa00', emphasisScale: 1.3,
    backColor: '#ff8647', backOpacity: 60,
  });

  // 副字幕位于主字幕下方，使用独立颜色、描边及边距。
  const ASS_DEFAULT_EXTENSION_STYLE = Object.freeze({
    ...ASS_DEFAULT_STYLE,
    id: 'ass-extension', name: 'ASS 副字幕样式',
    primaryColor: '#eac953', emphasisColor: '#ffaa00',
    fontSize: 64, outline: 2, marginV: 36,
  });

  const ASS_DEFAULT_ANIMATIONS = Object.freeze({
    fad: Object.freeze({ enabled: true, inMs: 250, outMs: 250 }),
    fade: Object.freeze({
      enabled: false, alpha1: 0, alpha2: 255, alpha3: 0,
      t1: 0, t2: 250, t3: 750, t4: 1000,
    }),
    move: Object.freeze({
      enabled: false, x1: 0, y1: 0, x2: 0, y2: 0, t1: 0, t2: 1000,
    }),
    t: Object.freeze({ enabled: false, startMs: 0, endMs: 1000, accel: 1, tags: '' }),
  });

  const ASS_DEFAULT_PROFILE = Object.freeze({
    id: 'ass', name: 'ASS 输出方案', builtin: true, styleId: 'ass',
    animations: ASS_DEFAULT_ANIMATIONS,
  });


  function normalizeAssStyleId(value, fallback = '') {
    const candidate = String(value ?? '').trim().toLowerCase();
    return ASS_STYLE_ID_RE.test(candidate) ? candidate : fallback;
  }


  function normalizeAssLibraryText(value, fallback = '', limit = ASS_STYLE_LIBRARY_MAX_NAME_LENGTH) {
    const normalized = String(value ?? '')
      .replace(/[\u0000-\u001f\u007f]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .replace(/,/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, limit);
    return normalized || fallback;
  }


  function normalizeAssAnimationText(value, fallback = '', limit = ASS_STYLE_LIBRARY_MAX_TRANSFORM_LENGTH) {
    const normalized = String(value ?? '')
      .replace(/[\u0000-\u001f\u007f]/gu, ' ')
      .replace(/[{}]/gu, '')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, limit);
    return normalized || fallback;
  }


  function normalizeAssLibraryColor(value, fallback = '#ffffff') {
    const candidate = String(value ?? '').trim().toLowerCase();
    return /^#[0-9a-f]{6}$/iu.test(candidate) ? candidate : fallback;
  }


  function normalizeAssLibraryNumber(value, fallback, min, max, integer = true) {
    const numeric = Number(value);
    const safe = Number.isFinite(numeric) ? numeric : Number(fallback);
    const clamped = Math.min(max, Math.max(min, safe));
    return integer ? Math.round(clamped) : clamped;
  }


  function normalizeAssLibraryBoolean(value, fallback = false) {
    return typeof value === 'boolean' ? value : fallback;
  }


  /** @param {import('./utils-types.js').MutableValue<typeof ASS_DEFAULT_STYLE> & {emphasisSyntax?: string}} [fallback] */
  function normalizeAssStyle(value, fallback = ASS_DEFAULT_ASS_STYLE, styleId = '') {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const base = { ...fallback };
    delete base.emphasisSyntax;
    const resolvedId = normalizeAssStyleId(styleId || source.id || fallback.id, fallback.id || 'ass');
    return {
      ...base,
      id: resolvedId,
      name: normalizeAssLibraryText(source.name, fallback.name || '样式'),
      builtin: Boolean(fallback.builtin),
      fontName: normalizeAssLibraryText(source.fontName, fallback.fontName || ASS_DEFAULT_FONT_FAMILY, ASS_STYLE_LIBRARY_MAX_FONT_LENGTH),
      fontSize: normalizeAssLibraryNumber(source.fontSize, fallback.fontSize || 18, 1, 512),
      primaryColor: normalizeAssLibraryColor(source.primaryColor, fallback.primaryColor || '#ffffff'),
      emphasisColor: normalizeAssLibraryColor(source.emphasisColor, fallback.emphasisColor || '#ffd34d'),
      emphasisScale: Math.round(normalizeAssLibraryNumber(source.emphasisScale, fallback.emphasisScale ?? 1.1, 1, 1.5, false) * 20) / 20,
      commentColor: normalizeAssLibraryColor(source.commentColor, fallback.commentColor || '#9aa4ad'),
      commentStyle: ['text', 'stroke'].includes(source.commentStyle)
        ? source.commentStyle : (fallback.commentStyle || 'text'),
      commentScale: Math.round(normalizeAssLibraryNumber(source.commentScale, fallback.commentScale ?? 1, 0.5, 1.5, false) * 20) / 20,
      smallTextScale: Math.round(normalizeAssLibraryNumber(source.smallTextScale, fallback.smallTextScale ?? 0.8, 0.1, 1, false) * 20) / 20,
      largeTextScale: Math.round(normalizeAssLibraryNumber(source.largeTextScale, fallback.largeTextScale ?? 1.5, 1, 3, false) * 20) / 20,
      emphasisStyle: ['text', 'stroke'].includes(source.emphasisStyle)
        ? source.emphasisStyle : (fallback.emphasisStyle || 'text'),
      secondaryColor: normalizeAssLibraryColor(source.secondaryColor, fallback.secondaryColor || '#ffffff'),
      outlineColor: normalizeAssLibraryColor(source.outlineColor, fallback.outlineColor || '#000000'),
      backColor: normalizeAssLibraryColor(source.backColor, fallback.backColor || '#000000'),
      // 旧库缺少透明度字段时保持完全不透明；新内置参数显式携带透明度。
      outlineOpacity: normalizeAssLibraryNumber(source.outlineOpacity, 100, 0, 100),
      backOpacity: normalizeAssLibraryNumber(source.backOpacity, 100, 0, 100),
      bold: normalizeAssLibraryBoolean(source.bold, Boolean(fallback.bold)),
      italic: normalizeAssLibraryBoolean(source.italic, Boolean(fallback.italic)),
      underline: normalizeAssLibraryBoolean(source.underline, Boolean(fallback.underline)),
      strikeOut: normalizeAssLibraryBoolean(source.strikeOut, Boolean(fallback.strikeOut)),
      scaleX: normalizeAssLibraryNumber(source.scaleX, fallback.scaleX ?? 100, 0, 1000),
      scaleY: normalizeAssLibraryNumber(source.scaleY, fallback.scaleY ?? 100, 0, 1000),
      spacing: normalizeAssLibraryNumber(source.spacing, fallback.spacing ?? 0, -100, 100),
      angle: normalizeAssLibraryNumber(source.angle, fallback.angle ?? 0, -360, 360),
      borderStyle: normalizeAssLibraryNumber(source.borderStyle, fallback.borderStyle ?? 1, 1, 4),
      outline: normalizeAssLibraryNumber(source.outline, fallback.outline ?? 2, 0, 100),
      shadow: normalizeAssLibraryNumber(source.shadow, fallback.shadow ?? 0, 0, 100),
      alignment: normalizeAssLibraryNumber(source.alignment, fallback.alignment ?? 2, 1, 9),
      marginL: normalizeAssLibraryNumber(source.marginL, fallback.marginL ?? 10, 0, 9999),
      marginR: normalizeAssLibraryNumber(source.marginR, fallback.marginR ?? 10, 0, 9999),
      marginV: normalizeAssLibraryNumber(source.marginV, fallback.marginV ?? 40, 0, 9999),
      encoding: normalizeAssLibraryNumber(source.encoding, fallback.encoding ?? 1, 0, 255),
    };
  }


  function normalizeAssAnimations(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const fad = source.fad && typeof source.fad === 'object' ? source.fad : {};
    const fade = source.fade && typeof source.fade === 'object' ? source.fade : {};
    const move = source.move && typeof source.move === 'object' ? source.move : {};
    const transform = source.t && typeof source.t === 'object' ? source.t : {};
    return {
      fad: {
        enabled: normalizeAssLibraryBoolean(fad.enabled),
        inMs: normalizeAssLibraryNumber(fad.inMs, 250, 0, 60000),
        outMs: normalizeAssLibraryNumber(fad.outMs, 250, 0, 60000),
      },
      fade: (() => {
        const t1 = normalizeAssLibraryNumber(fade.t1, 0, 0, 60000);
        const t2 = Math.max(t1, normalizeAssLibraryNumber(fade.t2, 250, 0, 60000));
        const t3 = Math.max(t2, normalizeAssLibraryNumber(fade.t3, 750, 0, 60000));
        const t4 = Math.max(t3, normalizeAssLibraryNumber(fade.t4, 1000, 0, 60000));
        return {
          enabled: normalizeAssLibraryBoolean(fade.enabled),
          alpha1: normalizeAssLibraryNumber(fade.alpha1, 0, 0, 255),
          alpha2: normalizeAssLibraryNumber(fade.alpha2, 255, 0, 255),
          alpha3: normalizeAssLibraryNumber(fade.alpha3, 0, 0, 255),
          t1, t2, t3, t4,
        };
      })(),
      move: {
        enabled: normalizeAssLibraryBoolean(move.enabled),
        x1: normalizeAssLibraryNumber(move.x1, 0, -65535, 65535),
        y1: normalizeAssLibraryNumber(move.y1, 0, -65535, 65535),
        x2: normalizeAssLibraryNumber(move.x2, 0, -65535, 65535),
        y2: normalizeAssLibraryNumber(move.y2, 0, -65535, 65535),
        t1: normalizeAssLibraryNumber(move.t1, 0, 0, 60000),
        t2: Math.max(
          normalizeAssLibraryNumber(move.t1, 0, 0, 60000),
          normalizeAssLibraryNumber(move.t2, 1000, 0, 60000),
        ),
      },
      t: {
        enabled: normalizeAssLibraryBoolean(transform.enabled),
        startMs: normalizeAssLibraryNumber(transform.startMs, 0, 0, 60000),
        endMs: Math.max(
          normalizeAssLibraryNumber(transform.startMs, 0, 0, 60000),
          normalizeAssLibraryNumber(transform.endMs, 1000, 0, 60000),
        ),
        accel: normalizeAssLibraryNumber(transform.accel, 1, 0.01, 100, false),
        tags: normalizeAssAnimationText(transform.tags, '', ASS_STYLE_LIBRARY_MAX_TRANSFORM_LENGTH),
      },
    };
  }


  /** @param {import('./utils-types.js').MutableValue<typeof ASS_DEFAULT_PROFILE>} [fallback] */
  function normalizeAssProfile(value, fallback = ASS_DEFAULT_PROFILE, profileId = '') {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const resolvedId = normalizeAssStyleId(profileId || source.id || fallback.id, fallback.id || 'ass');
    return {
      ...fallback,
      id: resolvedId,
      name: normalizeAssLibraryText(source.name, fallback.name || 'ASS'),
      builtin: Boolean(fallback.builtin),
      styleId: normalizeAssStyleId(source.styleId, fallback.styleId || 'ass') || 'ass',
      animations: normalizeAssAnimations(source.animations),
    };
  }


  function defaultAssStyleLibrary() {
    return {
      schema: ASS_STYLE_LIBRARY_SCHEMA,
      version: 2,
      styles: [
        cloneJsonValue(ASS_DEFAULT_STYLE),
        cloneJsonValue(ASS_DEFAULT_ASS_STYLE),
        cloneJsonValue(ASS_DEFAULT_EXTENSION_STYLE),
      ],
      assProfiles: [cloneJsonValue(ASS_DEFAULT_PROFILE)],
      assignments: { srtBurnStyleId: 'default', assExportProfileId: 'ass', assExtensionStyleId: 'ass-extension' },
    };
  }


  function normalizeAssStyleLibrary(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const previousVersion = Number.isInteger(source.version) ? source.version : 1;
    const styleMap = new Map([
      ['default', normalizeAssStyle(ASS_DEFAULT_STYLE, ASS_DEFAULT_STYLE, 'default')],
      ['ass', normalizeAssStyle(ASS_DEFAULT_ASS_STYLE, ASS_DEFAULT_ASS_STYLE, 'ass')],
      ['ass-extension', normalizeAssStyle(ASS_DEFAULT_EXTENSION_STYLE, ASS_DEFAULT_EXTENSION_STYLE, 'ass-extension')],
    ]);
    if (Array.isArray(source.styles)) {
      source.styles.forEach((raw) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
        const id = normalizeAssStyleId(raw.id);
        if (!id) return;
        const fallback = styleMap.get(id) || { ...ASS_DEFAULT_ASS_STYLE, id, name: '自定义样式', builtin: false };
        const normalized = normalizeAssStyle(raw, fallback, id);
        if (id !== 'default' && id !== 'ass' && id !== 'ass-extension') normalized.builtin = false;
        styleMap.set(id, normalized);
      });
    }
    const styles = [...styleMap.values()].slice(0, 64);
    // v1 used 1.0 as the built-in emphasis default. Migrate only that old
    // built-in value so custom styles and explicit v2 values remain intact.
    if (previousVersion < 2) {
      styles.forEach((style) => {
        if (['default', 'ass', 'ass-extension'].includes(style.id) && style.emphasisScale === 1) {
          style.emphasisScale = 1.1;
        }
      });
    }
    // 内置条目若仍使用旧默认名，迁移到当前默认名；用户自定义过的名字不动。
    const legacyBuiltinStyleNames = { ass: 'ASS' };
    styles.forEach((style) => {
      const legacy = legacyBuiltinStyleNames[style.id];
      if (legacy && style.name === legacy) {
        style.name = (style.id === 'ass' ? ASS_DEFAULT_ASS_STYLE : ASS_DEFAULT_STYLE).name;
      }
    });
    const profileMap = new Map([
      ['ass', normalizeAssProfile(ASS_DEFAULT_PROFILE, ASS_DEFAULT_PROFILE, 'ass')],
    ]);
    if (Array.isArray(source.assProfiles)) {
      source.assProfiles.forEach((raw) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
        const id = normalizeAssStyleId(raw.id);
        if (!id) return;
        const fallback = profileMap.get(id) || { ...ASS_DEFAULT_PROFILE, id, name: '自定义 ASS', builtin: false };
        const normalized = normalizeAssProfile(raw, fallback, id);
        if (id !== 'ass') normalized.builtin = false;
        profileMap.set(id, normalized);
      });
    }
    const styleIds = new Set(styles.map((style) => style.id));
    const profiles = [...profileMap.values()].slice(0, 64).map((profile) => ({
      ...profile,
      styleId: styleIds.has(profile.styleId) ? profile.styleId : 'ass',
    }));
    // 内置方案旧默认名迁移（同上，用户自定义过的名字不动）。
    profiles.forEach((profile) => {
      if (profile.id === 'ass' && profile.name === 'ASS') {
        profile.name = ASS_DEFAULT_PROFILE.name;
      }
    });
    // 内置副字幕样式旧默认色迁移：仅精确匹配旧默认值，用户改过颜色的不动。
    styles.forEach((style) => {
      if (style.id === 'ass-extension' && style.primaryColor === '#ffd34d') {
        style.primaryColor = ASS_DEFAULT_EXTENSION_STYLE.primaryColor;
      }
    });
    const assignments = source.assignments && typeof source.assignments === 'object'
      ? source.assignments : {};
    const srtBurnStyleId = styleIds.has(normalizeAssStyleId(assignments.srtBurnStyleId))
      ? normalizeAssStyleId(assignments.srtBurnStyleId) : 'default';
    const profileIds = new Set(profiles.map((profile) => profile.id));
    const assExportProfileId = profileIds.has(normalizeAssStyleId(assignments.assExportProfileId))
      ? normalizeAssStyleId(assignments.assExportProfileId) : 'ass';
    const assExtensionStyleId = styleIds.has(normalizeAssStyleId(assignments.assExtensionStyleId))
      ? normalizeAssStyleId(assignments.assExtensionStyleId) : 'ass-extension';
    return {
      schema: ASS_STYLE_LIBRARY_SCHEMA,
      version: 2,
      styles,
      assProfiles: profiles.length ? profiles : [normalizeAssProfile(ASS_DEFAULT_PROFILE)],
      assignments: { srtBurnStyleId, assExportProfileId, assExtensionStyleId },
    };
  }


  function assStyleForId(library, styleId) {
    const normalized = normalizeAssStyleLibrary(library);
    return normalized.styles.find((style) => style.id === normalizeAssStyleId(styleId, 'default'))
      || normalized.styles[0];
  }


  function assProfileForId(library, profileId) {
    const normalized = normalizeAssStyleLibrary(library);
    return normalized.assProfiles.find((profile) => profile.id === normalizeAssStyleId(profileId, 'ass'))
      || normalized.assProfiles[0];
  }


  function assStyleLine(style, name = 'Default', fontSizeOverride = null) {
    const normalized = normalizeAssStyle(style);
    const boolValue = (key) => normalized[key] ? -1 : 0;
    const values = [
      name,
      normalized.fontName,
      fontSizeOverride || normalized.fontSize,
      assColorFromHex(normalized.primaryColor),
      assColorFromHex(normalized.secondaryColor),
      assColorFromHex(normalized.outlineColor, ASS_DEFAULT_COLOR, normalized.outlineOpacity),
      assColorFromHex(normalized.backColor, ASS_DEFAULT_COLOR, normalized.backOpacity),
      boolValue('bold'),
      boolValue('italic'),
      boolValue('underline'),
      boolValue('strikeOut'),
      normalized.scaleX,
      normalized.scaleY,
      normalized.spacing,
      normalized.angle,
      normalized.borderStyle,
      normalized.outline,
      normalized.shadow,
      normalized.alignment,
      normalized.marginL,
      normalized.marginR,
      normalized.marginV,
      normalized.encoding,
    ];
    return `Style: ${values.join(',')}`;
  }


  function assColorFromTag(value) {
    const raw = String(value ?? '').trim().replace(/^&H/iu, '').replace(/&$/u, '');
    if (!/^[0-9a-f]{6,8}$/iu.test(raw)) return null;
    const hex = raw.slice(-6);
    return `#${hex.slice(4, 6)}${hex.slice(2, 4)}${hex.slice(0, 2)}`.toLowerCase();
  }


  function assTransformStyleTargets(value) {
    const source = String(value ?? '').replace(/[{}]/gu, '');
    const target = {};
    const number = (pattern, key, min = -Infinity, max = Infinity) => {
      const match = pattern.exec(source);
      if (!match) return;
      const numeric = Number(match[1]);
      if (Number.isFinite(numeric)) target[key] = Math.min(max, Math.max(min, numeric));
    };
    number(/\\fs(-?[0-9]+(?:\\.[0-9]+)?)/iu, 'fontSize', 1, 512);
    number(/\\fscx(-?[0-9]+(?:\\.[0-9]+)?)/iu, 'scaleX', 0, 1000);
    number(/\\fscy(-?[0-9]+(?:\\.[0-9]+)?)/iu, 'scaleY', 0, 1000);
    number(/\\fsp(-?[0-9]+(?:\\.[0-9]+)?)/iu, 'spacing', -100, 100);
    number(/\\(?:frz|fr)(-?[0-9]+(?:\\.[0-9]+)?)/iu, 'angle', -360, 360);
    number(/\\frx(-?[0-9]+(?:\\.[0-9]+)?)/iu, 'rotationX', -360, 360);
    number(/\\fry(-?[0-9]+(?:\\.[0-9]+)?)/iu, 'rotationY', -360, 360);
    number(/\\bord(-?[0-9]+(?:\\.[0-9]+)?)/iu, 'outline', 0, 100);
    number(/\\(?:xbord|ybord)(-?[0-9]+(?:\\.[0-9]+)?)/iu, 'outline', 0, 100);
    number(/\\shad(-?[0-9]+(?:\\.[0-9]+)?)/iu, 'shadow', 0, 100);
    number(/\\(?:b)(-?[0-9]+)/iu, 'bold', 0, 1);
    number(/\\(?:i)(-?[0-9]+)/iu, 'italic', 0, 1);
    number(/\\(?:u)(-?[0-9]+)/iu, 'underline', 0, 1);
    number(/\\(?:s)(-?[0-9]+)/iu, 'strikeOut', 0, 1);
    const primaryColor = /\\(?:1c|c)(&H[0-9a-f]{6,8}&?)/iu.exec(source);
    if (primaryColor) target.primaryColor = assColorFromTag(primaryColor[1]);
    const outlineColor = /\\3c(&H[0-9a-f]{6,8}&?)/iu.exec(source);
    if (outlineColor) target.outlineColor = assColorFromTag(outlineColor[1]);
    const alpha = /\\alpha(&H[0-9a-f]{2}&?)/iu.exec(source)
      || /\\1a(&H[0-9a-f]{2}&?)/iu.exec(source);
    if (alpha) {
      const valueText = alpha[1].replace(/^&H|&$/giu, '');
      const numeric = Number.parseInt(valueText, 16);
      if (Number.isFinite(numeric)) target.alpha = Math.min(255, Math.max(0, numeric));
    }
    return target;
  }


  function interpolateAssColor(start, end, progress) {
    const from = normalizeAssLibraryColor(start, '#ffffff');
    const to = normalizeAssLibraryColor(end, from);
    const channels = [1, 3, 5].map((offset) => {
      const a = Number.parseInt(from.slice(offset, offset + 2), 16);
      const b = Number.parseInt(to.slice(offset, offset + 2), 16);
      return Math.round(a + (b - a) * progress).toString(16).padStart(2, '0');
    });
    return `#${channels.join('')}`;
  }


  function assPreviewStyleAt(style, transformTags, progress = 1) {
    const base = normalizeAssStyle(style);
    const target = assTransformStyleTargets(transformTags);
    const amount = Math.min(1, Math.max(0, Number(progress) || 0));
    const result = { ...base, alpha: 0, rotationX: 0, rotationY: 0 };
    const numericKeys = [
      'fontSize', 'scaleX', 'scaleY', 'spacing', 'angle', 'outline', 'shadow',
      'rotationX', 'rotationY', 'alpha',
    ];
    numericKeys.forEach((key) => {
      if (target[key] === undefined) return;
      const start = Number(result[key]) || 0;
      result[key] = start + (Number(target[key]) - start) * amount;
    });
    ['primaryColor', 'outlineColor'].forEach((key) => {
      if (target[key]) result[key] = interpolateAssColor(result[key], target[key], amount);
    });
    ['bold', 'italic', 'underline', 'strikeOut'].forEach((key) => {
      if (target[key] !== undefined) result[key] = amount >= 0.5 ? Boolean(target[key]) : Boolean(base[key]);
    });
    return result;
  }


  function normalizeAssFontFamily(value) {
    const key = String(value ?? '').trim();
    const family = ({
      default: ASS_DEFAULT_FONT_FAMILY,
      yahei: 'Microsoft YaHei',
      hei: 'SimHei',
      song: 'SimSun',
      sans: 'Arial',
    })[key] || key || ASS_DEFAULT_FONT_FAMILY;
    // Fontname is a comma-delimited ASS style field. Keep custom local font
    // names intact where possible, but do not let a malformed name shift the
    // remaining style columns.
    return family.replace(/[\r\n,]/g, ' ').replace(/\s+/g, ' ').trim() || ASS_DEFAULT_FONT_FAMILY;
  }


  function assAlphaFromOpacity(opacity, fallbackOpacity = 100) {
    // ASS 的 AA 通道与直觉相反：00 = 不透明，FF = 全透明；这里用常见的
    // 「不透明度百分比」（100 = 不透明）换算成 ASS alpha 字节。
    const value = Number(opacity);
    const normalized = Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : fallbackOpacity;
    return Math.round(((100 - normalized) * 255) / 100);
  }


  function assColorFromHex(value, fallback = ASS_DEFAULT_COLOR, opacity = 100) {
    const raw = String(value ?? '').trim();
    const fallbackColor = String(fallback ?? ASS_DEFAULT_COLOR).trim();
    const hex = /^#[0-9a-f]{6}$/i.test(raw) ? raw
      : (/^#[0-9a-f]{6}$/i.test(fallbackColor) ? fallbackColor : ASS_DEFAULT_COLOR);
    // ASS stores colours as &HAABBGGRR; AA=00 is fully opaque.
    const alphaHex = assAlphaFromOpacity(opacity).toString(16).padStart(2, '0');
    return `&H${alphaHex}${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`.toUpperCase();
  }


  function assCssColorWithOpacity(value, opacity = 100, fallback = ASS_DEFAULT_COLOR) {
    // CSS 预览侧的对应换算：rgba 的 alpha 就是「不透明度」本身（1 = 不透明）。
    // 注意与 ASS 的 AA 通道方向相反，不能复用 assAlphaFromOpacity。
    const raw = String(value ?? '').trim();
    const fallbackColor = String(fallback ?? ASS_DEFAULT_COLOR).trim();
    const hex = /^#[0-9a-f]{6}$/i.test(raw) ? raw
      : (/^#[0-9a-f]{6}$/i.test(fallbackColor) ? fallbackColor : ASS_DEFAULT_COLOR);
    const numeric = Number(opacity);
    const alpha = Math.round((Number.isFinite(numeric) ? Math.min(100, Math.max(0, numeric)) : 100)) / 100;
    return `rgba(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)}, ${alpha})`;
  }


  function assOverrideColorFromHex(value, fallback = ASS_DEFAULT_COLOR) {
    // Override tags use the trailing ampersand as their colour terminator;
    // style fields intentionally keep the legacy value without it.
    return `${assColorFromHex(value, fallback)}&`;
  }


  function normalizeAssTimeMs(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : 0;
  }


  function formatAssTime(ms) {
    const numeric = Number(ms);
    const centiseconds = Number.isFinite(numeric)
      ? Math.max(0, Math.round(numeric / 10)) : 0;
    const hours = Math.floor(centiseconds / 360000);
    const minutes = Math.floor((centiseconds % 360000) / 6000);
    const seconds = Math.floor((centiseconds % 6000) / 100);
    const hundredths = centiseconds % 100;
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`;
  }


  function escapeAssText(text) {
    return String(text ?? '')
      .replace(/\r\n?/g, '\n')
      .replace(/\\/g, '\\\\')
      .replace(/{/g, '\\{')
      .replace(/}/g, '\\}')
      .replace(/\n/g, '\\N');
  }


  function normalizeAssFontSize(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return ASS_AUTO_FONT_SIZE_1080P;
    return Math.min(512, Math.max(1, Math.round(numeric)));
  }


  function resolveAssFontSize(value, playResY) {
    const numericPreviewSize = Number(value);
    const previewSize = Number.isFinite(numericPreviewSize) && numericPreviewSize > 0
      ? numericPreviewSize : ASS_DEFAULT_PREVIEW_FONT_SIZE;
    const numericPlayResY = Number(playResY);
    const scale = Number.isFinite(numericPlayResY) && numericPlayResY > 0
      ? numericPlayResY / ASS_REFERENCE_PLAY_RES_Y : 1;
    return normalizeAssFontSize(previewSize * ASS_PREVIEW_TO_ASS_SCALE * scale);
  }


  function normalizeAssDimension(value, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
    return Math.min(65535, Math.max(1, Math.round(numeric)));
  }


  function normalizeAssPlayResolution(width, height) {
    const numericWidth = Number(width);
    const numericHeight = Number(height);
    if (!Number.isFinite(numericWidth) || numericWidth <= 0
        || !Number.isFinite(numericHeight) || numericHeight <= 0) {
      return { width: ASS_DEFAULT_PLAY_RES_X, height: ASS_DEFAULT_PLAY_RES_Y };
    }
    return {
      width: normalizeAssDimension(numericWidth, ASS_DEFAULT_PLAY_RES_X),
      height: normalizeAssDimension(numericHeight, ASS_DEFAULT_PLAY_RES_Y),
    };
  }

  return Object.freeze({ ASS_COLOR_STYLE_NAMES, ASS_DEFAULT_ANIMATIONS, ASS_DEFAULT_ASS_STYLE, ASS_DEFAULT_COLOR, ASS_DEFAULT_EXTENSION_STYLE, ASS_DEFAULT_PLAY_RES_X, ASS_DEFAULT_PLAY_RES_Y, ASS_DEFAULT_PROFILE, ASS_DEFAULT_STYLE, ASS_EVENT_FORMAT, ASS_FALLBACK_COLOR_PALETTE, ASS_REFERENCE_PLAY_RES_Y, ASS_STYLE_FORMAT, ASS_STYLE_LIBRARY_SCHEMA, assAlphaFromOpacity, assColorFromHex, assCssColorWithOpacity, assDefaultFontFamily, assEmphasisRuns, assInlineStyleRuns, assOverrideColorFromHex, assPreviewStyleAt, assProfileForId, assStyleForId, assStyleLine, assTransformStyleTargets, defaultAssStyleLibrary, escapeAssText, formatAssTime, normalizeAssAnimations, normalizeAssColorStyle, normalizeAssFontFamily, normalizeAssFontSize, normalizeAssLibraryColor, normalizeAssPlayResolution, normalizeAssProfile, normalizeAssStyle, normalizeAssStyleLibrary, normalizeAssTimeMs, resolveAssFontSize });
}
