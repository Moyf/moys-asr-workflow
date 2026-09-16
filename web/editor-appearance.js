// 字幕外观：字体/颜色/背景规范化、本机字体扫描与主副字幕外观应用。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweAppearance 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweAppearance(global) {
  'use strict';



  // === 字幕预览几何（preview.subtitle）===
  // 归一化 {x,y,width,height} 存于 DATA.preview.subtitle。纯钳制/归一化逻辑在
  // AsrEditorUtils（已单测）；这里只负责 DOM 应用、指针/键盘手势、每手势一条撤销、脏标记。
  const GEO_UTILS = window.AsrEditorUtils;


  let previewGeometryDirty = false;



  function getPreviewGeometry() {
    return GEO_UTILS.normalizePreviewGeometry(MaweBoot.DATA.preview?.subtitle);
  }


  function normalizeSubtitleFontFamilyName(value) {
    if (typeof value !== 'string') return null;
    const family = value.trim();
    if (!family || family.length > MaweSettings.SUBTITLE_FONT_FAMILY_MAX_LENGTH
        || /[\u0000-\u001f\u007f]/u.test(family)) return null;
    return family;
  }


  function normalizeSubtitleBackgroundColor(value) {
    if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/iu.test(value)) return null;
    return value.toLowerCase();
  }


  function normalizeSubtitleBackgroundAlpha(value) {
    return typeof value === 'number' && Number.isFinite(value)
      && MaweSettings.SUBTITLE_BACKGROUND_ALPHA_MIN <= value && value <= MaweSettings.SUBTITLE_BACKGROUND_ALPHA_MAX
      ? value : null;
  }


  function subtitleBackgroundCss(appearance) {
    const color = appearance.background_color || MaweSettings.SUBTITLE_BACKGROUND_COLOR_DEFAULT;
    const channels = [color.slice(1, 3), color.slice(3, 5), color.slice(5, 7)]
      .map((channel) => Number.parseInt(channel, 16)).join(', ');
    const alpha = appearance.background_alpha ?? MaweSettings.SUBTITLE_BACKGROUND_ALPHA_DEFAULT;
    return `rgba(${channels}, ${alpha})`;
  }


  function isBuiltInSubtitleFontFamily(value) {
    return Object.prototype.hasOwnProperty.call(MaweSettings.SUBTITLE_FONT_FAMILY_CSS, value);
  }


  function quoteCssString(value) {
    return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }


  function subtitleFontFamilyCss(value) {
    if (!value || value === 'default') return '';
    if (isBuiltInSubtitleFontFamily(value)) return MaweSettings.SUBTITLE_FONT_FAMILY_CSS[value];
    return `${quoteCssString(value)}, var(--font-sans)`;
  }


  const SUBTITLE_FONT_FAMILY_STATUS_TEXT = Object.freeze({
    zh: Object.freeze({
      idle: '点击读取本机字体（首次需要授权）',
      reading: '正在读取本机字体…',
      success: (count) => `已读取 ${count} 种本机字体`,
      empty: '未读取到可用的本机字体',
      unsupported: '当前环境不支持自动读取本机字体',
      denied: '未获准读取本机字体',
      failed: '读取本机字体失败，请重试',
    }),
    en: Object.freeze({
      idle: 'Click to read local fonts (permission required the first time)',
      reading: 'Reading local fonts…',
      success: (count) => `Read ${count} local font families`,
      empty: 'No usable local fonts were returned',
      unsupported: 'This environment cannot list local fonts automatically',
      denied: 'Permission to read local fonts was not granted',
      failed: 'Could not read local fonts; try again',
    }),
  });


  let subtitleFontFamilyScanState = 'idle';


  let subtitleFontFamilyScanCount = 0;


  function renderSubtitleFontFamilyStatus() {
    if (!MaweDom.subtitleFontFamilyStatus) return;
    const language = window.MAWE_I18N?.language === 'en' ? 'en' : 'zh';
    const text = SUBTITLE_FONT_FAMILY_STATUS_TEXT[language][subtitleFontFamilyScanState];
    MaweDom.subtitleFontFamilyStatus.textContent = typeof text === 'function'
      ? text(subtitleFontFamilyScanCount) : text;
  }


  function setSubtitleFontFamilyScanState(state, count = 0) {
    subtitleFontFamilyScanState = state;
    subtitleFontFamilyScanCount = count;
    renderSubtitleFontFamilyStatus();
  }


  function subtitleFontFamilyOptionExists(select, value) {
    return !!select && Array.from(select.options).some((option) => option.value === value);
  }


  function subtitleFontFamilyDisplayName(family) {
    const language = window.MAWE_I18N?.language === 'en' ? 'en' : 'zh';
    // 启动早期 applySubtitleAppearance() 会先生成自定义字体选项，此时
    // GEO_UTILS 别名（文件后部才初始化）尚处于暂时性死区；直接读共享工具层，
    // 不可用时先用原始字体名占位，别名就绪后由 relabelSubtitleFontFamilyOptions 统一本地化。
    return window.AsrEditorUtils?.subtitleFontFamilyDisplayName(family, language) ?? family;
  }


  function relabelSubtitleFontFamilyOptions() {
  [MaweDom.extensionSubtitleFontFamilySelect].filter(Boolean).forEach((select) => {
    Array.from(select.querySelectorAll('option[data-local-font="true"], option[data-generated="true"]')).forEach((option) => {
      option.textContent = subtitleFontFamilyDisplayName(option.value);
    });
  });
  rebuildSubtitleFontFamilyOptions();
  rebuildAssFontNameOptions();
  syncSubtitleAppearanceControls();
}


  function normalizeSubtitleColor(value) {
    if (typeof value !== 'string') return null;
    const color = value.trim().toLowerCase();
    return /^#[0-9a-f]{6}$/i.test(color) ? color : null;
  }


  function normalizeSubtitleAppearance(value) {
  const result = {};
  const fontSize = value && typeof value.font_size === 'number' && Number.isFinite(value.font_size)
    ? Math.round(value.font_size) : null;
  if (fontSize !== null && fontSize >= MaweSettings.SUBTITLE_FONT_SIZE_MIN && fontSize <= MaweSettings.SUBTITLE_FONT_SIZE_MAX) {
    result.font_size = fontSize;
  }
  const fontFamily = normalizeSubtitleFontFamilyName(value?.font_family);
  if (fontFamily) result.font_family = fontFamily;
  const backgroundColor = normalizeSubtitleBackgroundColor(value?.background_color);
  if (backgroundColor) result.background_color = backgroundColor;
  const backgroundAlpha = normalizeSubtitleBackgroundAlpha(value?.background_alpha);
  if (backgroundAlpha !== null) result.background_alpha = backgroundAlpha;
  const color = normalizeSubtitleColor(value?.color);
  if (color) result.color = color;
  const colorStyle = normalizeSubtitleColorStyle(value?.color_style);
  if (colorStyle) result.color_style = colorStyle;
  const assColorStyle = normalizeAssColorStyleValue(value?.ass_color_style);
  if (assColorStyle) result.ass_color_style = assColorStyle;
  if (value?.color_underline === false) result.color_underline = false;
  return result;
}


  function getSubtitleAppearance(value = MaweBoot.DATA.preview?.subtitle) {
  const result = normalizeSubtitleAppearance(value);
  return {
    ...result,
    color: result.color || MaweSettings.DEFAULT_SUBTITLE_COLOR,
    color_underline: result.color_underline !== false,
    color_style: result.color_style || MaweSettings.DEFAULT_SUBTITLE_COLOR_STYLE,
    ass_color_style: result.ass_color_style || DEFAULT_ASS_COLOR_STYLE,
  };
}


  function getStoredExtensionSubtitleAppearance(value = MaweBoot.DATA.preview?.extension_subtitle) {
    return normalizeSubtitleAppearance(value);
  }


  function getExtensionSubtitleDefaultFontSize() {
    const mainSize = getSubtitleAppearance().font_size || MaweSettings.SUBTITLE_DEFAULT_FONT_SIZE;
    return Math.max(MaweSettings.SUBTITLE_FONT_SIZE_MIN, mainSize - 2);
  }


  function getExtensionSubtitleAppearance(value = MaweBoot.DATA.preview?.extension_subtitle) {
    const result = getStoredExtensionSubtitleAppearance(value);
    return {
      ...result,
      font_size: result.font_size || getExtensionSubtitleDefaultFontSize(),
      color: result.color || MaweSettings.DEFAULT_EXTENSION_SUBTITLE_COLOR,
    };
  }


  function syncSubtitleFontSizeSelect(select, sizeValue) {
    if (!select) return;
    const size = Number.isFinite(Number(sizeValue)) ? String(Math.round(Number(sizeValue))) : 'auto';
    select.querySelectorAll('option[data-generated="true"]').forEach((option) => option.remove());
    if (size !== 'auto' && !Array.from(select.options).some((option) => option.value === size)) {
      const option = document.createElement('option');
      option.value = size;
      option.textContent = `${size} px`;
      option.dataset.generated = 'true';
      select.append(option);
    }
    select.value = size;
  }


  function syncSubtitleAppearanceControls(appearance = getSubtitleAppearance()) {
  syncSubtitleFontSizeSelect(MaweDom.subtitleFontSizeSelect, appearance.font_size);
  syncAssModeDependentControls();
  if (MaweDom.subtitleColorUnderlineInput) {
    MaweDom.subtitleColorUnderlineInput.checked = appearance.color_underline !== false;
  }
  if (MaweDom.subtitleColorStyleSelect) {
    MaweDom.subtitleColorStyleSelect.value = appearance.color_style || MaweSettings.DEFAULT_SUBTITLE_COLOR_STYLE;
  }
  if (MaweDom.subtitleColorStyleControl) {
    MaweDom.subtitleColorStyleControl.hidden = appearance.color_underline === false;
  }
  if (assColorStyleSelect) {
    assColorStyleSelect.value = appearance.ass_color_style || DEFAULT_ASS_COLOR_STYLE;
  }
  if (subtitleFontFamilyInput && document.activeElement !== subtitleFontFamilyInput) {
    subtitleFontFamilyInput.value = subtitleFontFamilyStoredToInput(appearance.font_family || 'default');
  }
  if (MaweDom.subtitleBackgroundColorInput) {
    MaweDom.subtitleBackgroundColorInput.value = appearance.background_color
      || MaweSettings.SUBTITLE_BACKGROUND_COLOR_DEFAULT;
  }
  if (MaweDom.subtitleBackgroundAlphaInput) {
    const alpha = appearance.background_alpha ?? MaweSettings.SUBTITLE_BACKGROUND_ALPHA_DEFAULT;
    MaweDom.subtitleBackgroundAlphaInput.value = String(alpha);
    if (MaweDom.subtitleBackgroundAlphaValue) {
      MaweDom.subtitleBackgroundAlphaValue.textContent = `${Math.round(alpha * 100)}%`;
    }
  }
  if (MaweDom.subtitleColorInput) MaweDom.subtitleColorInput.value = appearance.color || MaweSettings.DEFAULT_SUBTITLE_COLOR;
  MaweSpeakerLabels.syncSpeakerLabelControls();
  MaweColors.syncSubtitleColorPaletteControls();
}


  function syncExtensionSubtitleAppearanceControls() {
    const stored = getStoredExtensionSubtitleAppearance();
    const appearance = getExtensionSubtitleAppearance();
    syncSubtitleFontSizeSelect(MaweDom.extensionSubtitleFontSizeSelect, stored.font_size);
    if (MaweDom.extensionSubtitleFontFamilySelect) {
      MaweDom.extensionSubtitleFontFamilySelect.querySelectorAll('option[data-generated="true"]')
        .forEach((option) => option.remove());
      const family = stored.font_family || 'default';
      if (family !== 'default' && !isBuiltInSubtitleFontFamily(family)
          && !subtitleFontFamilyOptionExists(MaweDom.extensionSubtitleFontFamilySelect, family)) {
        const option = document.createElement('option');
        option.value = family;
        option.textContent = subtitleFontFamilyDisplayName(family);
        option.dataset.generated = 'true';
        MaweDom.extensionSubtitleFontFamilySelect.append(option);
      }
      MaweDom.extensionSubtitleFontFamilySelect.value = family;
      if (MaweDom.extensionSubtitleFontFamilySelect.value !== family) MaweDom.extensionSubtitleFontFamilySelect.value = 'default';
    }
    if (MaweDom.extensionSubtitleColorInput) {
      MaweDom.extensionSubtitleColorInput.value = appearance.color || MaweSettings.DEFAULT_EXTENSION_SUBTITLE_COLOR;
    }
    if (MaweDom.extensionSubtitleBackgroundColorInput) {
      MaweDom.extensionSubtitleBackgroundColorInput.value = appearance.background_color
        || MaweSettings.SUBTITLE_BACKGROUND_COLOR_DEFAULT;
    }
    if (MaweDom.extensionSubtitleBackgroundAlphaInput) {
      const alpha = appearance.background_alpha ?? MaweSettings.SUBTITLE_BACKGROUND_ALPHA_DEFAULT;
      MaweDom.extensionSubtitleBackgroundAlphaInput.value = String(alpha);
      if (MaweDom.extensionSubtitleBackgroundAlphaValue) {
        MaweDom.extensionSubtitleBackgroundAlphaValue.textContent = `${Math.round(alpha * 100)}%`;
      }
    }
  }


  function applySubtitleAppearance(value = MaweBoot.DATA.preview?.subtitle) {
    const appearance = getSubtitleAppearance(value);
    MaweDom.overlayTextEl.style.setProperty(
      '--subtitle-preview-font-size',
      `${appearance.font_size || MaweSettings.SUBTITLE_DEFAULT_FONT_SIZE}px`,
    );
    MaweDom.overlayTextEl.style.fontFamily = subtitleFontFamilyCss(appearance.font_family);
    const hasCustomBackground = Object.prototype.hasOwnProperty.call(appearance, 'background_color')
      || Object.prototype.hasOwnProperty.call(appearance, 'background_alpha');
    MaweDom.overlayTextEl.style.backgroundColor = hasCustomBackground ? subtitleBackgroundCss(appearance) : '';
    MaweDom.overlayTextEl.style.color = appearance.color || MaweSettings.DEFAULT_SUBTITLE_COLOR;
    // The preview refresh caches the effective text color in a dataset value.
    // Applying the stored base appearance resets the inline color, so invalidate
    // that cache and let the next refresh reapply a color-snapshot style.
    delete MaweDom.overlayTextEl.dataset.colorText;
    syncSubtitleAppearanceControls(appearance);
  }


  function applyExtensionSubtitleAppearance(value = MaweBoot.DATA.preview?.extension_subtitle) {
    const appearance = getExtensionSubtitleAppearance(value);
    MaweDom.overlayExtensionTextEl.style.setProperty(
      '--subtitle-preview-font-size',
      `${appearance.font_size || MaweSettings.EXTENSION_SUBTITLE_DEFAULT_FONT_SIZE}px`,
    );
    MaweDom.overlayExtensionTextEl.style.fontFamily = subtitleFontFamilyCss(appearance.font_family);
    const hasCustomBackground = Object.prototype.hasOwnProperty.call(appearance, 'background_color')
      || Object.prototype.hasOwnProperty.call(appearance, 'background_alpha');
    MaweDom.overlayExtensionTextEl.style.backgroundColor = hasCustomBackground
      ? subtitleBackgroundCss(appearance) : '';
    MaweDom.overlayExtensionTextEl.style.color = appearance.color || MaweSettings.DEFAULT_EXTENSION_SUBTITLE_COLOR;
    syncExtensionSubtitleAppearanceControls();
  }


  function setSubtitleAppearance(patch, { markDirty = true } = {}) {
  const next = { ...getSubtitleAppearance() };
  if (Object.prototype.hasOwnProperty.call(patch, 'font_size')) {
    if (patch.font_size === null || patch.font_size === 'auto') delete next.font_size;
    else Object.assign(next, normalizeSubtitleAppearance({ font_size: patch.font_size }));
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'font_family')) {
    if (!patch.font_family || patch.font_family === 'default') delete next.font_family;
    else Object.assign(next, normalizeSubtitleAppearance({ font_family: patch.font_family }));
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'background_color')) {
    const backgroundColor = normalizeSubtitleBackgroundColor(patch.background_color);
    if (!backgroundColor || backgroundColor === MaweSettings.SUBTITLE_BACKGROUND_COLOR_DEFAULT) {
      delete next.background_color;
    } else {
      next.background_color = backgroundColor;
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'background_alpha')) {
    const backgroundAlpha = normalizeSubtitleBackgroundAlpha(patch.background_alpha);
    if (backgroundAlpha === null || backgroundAlpha === MaweSettings.SUBTITLE_BACKGROUND_ALPHA_DEFAULT) {
      delete next.background_alpha;
    } else {
      next.background_alpha = backgroundAlpha;
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'color')) {
    const color = normalizeSubtitleColor(patch.color);
    if (color) next.color = color;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'color_underline')) {
    // true 是默认值，不落盘；只在关闭时写入 color_underline: false。
    if (patch.color_underline) delete next.color_underline;
    else next.color_underline = false;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'color_style')) {
    const colorStyle = normalizeSubtitleColorStyle(patch.color_style);
    if (colorStyle) next.color_style = colorStyle;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'ass_color_style')) {
    const assColorStyle = normalizeAssColorStyleValue(patch.ass_color_style);
    if (assColorStyle) next.ass_color_style = assColorStyle;
  }
  if (!MaweBoot.DATA.preview || typeof MaweBoot.DATA.preview !== 'object') MaweBoot.DATA.preview = {};
  MaweBoot.DATA.preview.subtitle = {
    ...getPreviewGeometry(),
    ...next,
    speaker_labels: MaweSpeakerLabels.getSpeakerLabelSettings(),
  };
  if (markDirty) previewGeometryDirty = true;
  applySubtitleAppearance(MaweBoot.DATA.preview.subtitle);
  return next;
}


  function collectSubtitleLocalFontFamilies(fontData) {
    const families = new Map();
    for (const entry of Array.isArray(fontData) ? fontData : []) {
      const family = normalizeSubtitleFontFamilyName(entry?.family);
      if (!family || isBuiltInSubtitleFontFamily(family)) continue;
      const key = family.toLocaleLowerCase();
      if (!families.has(key)) families.set(key, family);
    }
    return [...families.values()].sort((left, right) => left.localeCompare(right, undefined, {
      sensitivity: 'base',
    }));
  }


  function replaceSubtitleLocalFontOptions(families) {
  subtitleLocalFontFamilies = Array.isArray(families) ? families : [];
  const select = MaweDom.extensionSubtitleFontFamilySelect;
  if (select) {
    select.querySelectorAll(
      'option[data-local-font="true"], option[data-generated="true"]',
    ).forEach((option) => option.remove());
    const existing = new Set(Array.from(select.options, (option) => option.value));
    const fragment = document.createDocumentFragment();
    families.forEach((family) => {
      if (existing.has(family)) return;
      const option = document.createElement('option');
      option.value = family;
      option.textContent = subtitleFontFamilyDisplayName(family);
      option.dataset.localFont = 'true';
      fragment.append(option);
      existing.add(family);
    });
    select.append(fragment);
  }
  rebuildSubtitleFontFamilyOptions();
  rebuildAssFontNameOptions();
  syncSubtitleAppearanceControls();
  syncExtensionSubtitleAppearanceControls();
}


  function initializeSubtitleFontFamilyScanner() {
    if (!MaweDom.subtitleFontFamilyScanButton) return;
    if (typeof window.queryLocalFonts !== 'function') {
      MaweDom.subtitleFontFamilyScanButton.disabled = true;
      setSubtitleFontFamilyScanState('unsupported');
      return;
    }
    MaweDom.subtitleFontFamilyScanButton.disabled = false;
    setSubtitleFontFamilyScanState('idle');
    void restoreGrantedSubtitleLocalFonts();
  }


  async function restoreGrantedSubtitleLocalFonts() {
    if (typeof window.queryLocalFonts !== 'function' || !window.navigator?.permissions?.query) return;
    try {
      const permission = await window.navigator.permissions.query({ name: 'local-fonts' });
      if (permission.state === 'granted') await scanSubtitleLocalFonts({ silent: true });
    } catch (_) {
      // 未知权限名或当前 WebView 不允许静默查询时，保留手动扫描入口。
    }
  }


  async function scanSubtitleLocalFonts({ silent = false } = {}) {
    if (typeof window.queryLocalFonts !== 'function') {
      setSubtitleFontFamilyScanState('unsupported');
      return;
    }
    if (MaweDom.subtitleFontFamilyScanButton) MaweDom.subtitleFontFamilyScanButton.disabled = true;
    if (!silent) setSubtitleFontFamilyScanState('reading');
    try {
      const fontData = await window.queryLocalFonts();
      const families = collectSubtitleLocalFontFamilies(fontData);
      replaceSubtitleLocalFontOptions(families);
      setSubtitleFontFamilyScanState(families.length ? 'success' : 'empty', families.length);
    } catch (error) {
      if (!silent) {
        setSubtitleFontFamilyScanState(
          error?.name === 'NotAllowedError' || error?.name === 'SecurityError' ? 'denied' : 'failed',
        );
      }
    } finally {
      if (MaweDom.subtitleFontFamilyScanButton) MaweDom.subtitleFontFamilyScanButton.disabled = false;
    }
  }


  function setExtensionSubtitleAppearance(patch, { markDirty = true } = {}) {
    const next = { ...getStoredExtensionSubtitleAppearance() };
    if (Object.prototype.hasOwnProperty.call(patch, 'font_size')) {
      if (patch.font_size === null || patch.font_size === 'auto') delete next.font_size;
      else Object.assign(next, normalizeSubtitleAppearance({ font_size: patch.font_size }));
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'font_family')) {
      if (!patch.font_family || patch.font_family === 'default') delete next.font_family;
      else Object.assign(next, normalizeSubtitleAppearance({ font_family: patch.font_family }));
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'background_color')) {
      const backgroundColor = normalizeSubtitleBackgroundColor(patch.background_color);
      if (!backgroundColor || backgroundColor === MaweSettings.SUBTITLE_BACKGROUND_COLOR_DEFAULT) {
        delete next.background_color;
      } else {
        next.background_color = backgroundColor;
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'background_alpha')) {
      const backgroundAlpha = normalizeSubtitleBackgroundAlpha(patch.background_alpha);
      if (backgroundAlpha === null || backgroundAlpha === MaweSettings.SUBTITLE_BACKGROUND_ALPHA_DEFAULT) {
        delete next.background_alpha;
      } else {
        next.background_alpha = backgroundAlpha;
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'color')) {
      const color = normalizeSubtitleColor(patch.color);
      if (color) next.color = color;
    }
    if (!MaweBoot.DATA.preview || typeof MaweBoot.DATA.preview !== 'object') MaweBoot.DATA.preview = {};
    if (Object.keys(next).length) MaweBoot.DATA.preview.extension_subtitle = next;
    else delete MaweBoot.DATA.preview.extension_subtitle;
    if (markDirty) previewGeometryDirty = true;
    applyExtensionSubtitleAppearance(MaweBoot.DATA.preview.extension_subtitle);
    return next;
  }


  function restoreExtensionSubtitleAppearance(value, { markDirty = true } = {}) {
    const next = normalizeSubtitleAppearance(value);
    if (!MaweBoot.DATA.preview || typeof MaweBoot.DATA.preview !== 'object') MaweBoot.DATA.preview = {};
    if (Object.keys(next).length) MaweBoot.DATA.preview.extension_subtitle = next;
    else delete MaweBoot.DATA.preview.extension_subtitle;
    if (markDirty) previewGeometryDirty = true;
    applyExtensionSubtitleAppearance(MaweBoot.DATA.preview.extension_subtitle);
  }


  function normalizeSubtitleColorStyle(value) {
    return typeof value === 'string' && MaweSettings.SUBTITLE_COLOR_STYLE_VALUES.includes(value)
      ? value : null;
  }

  global.MaweAppearance = Object.freeze({
    normalizeSubtitleColorStyle,
    GEO_UTILS,
    get previewGeometryDirty() { return previewGeometryDirty; },
    set previewGeometryDirty(v) { previewGeometryDirty = v; },
    getPreviewGeometry,
    normalizeSubtitleFontFamilyName,
    normalizeSubtitleBackgroundColor,
    normalizeSubtitleBackgroundAlpha,
    subtitleBackgroundCss,
    isBuiltInSubtitleFontFamily,
    quoteCssString,
    subtitleFontFamilyCss,
    SUBTITLE_FONT_FAMILY_STATUS_TEXT,
    get subtitleFontFamilyScanState() { return subtitleFontFamilyScanState; },
    set subtitleFontFamilyScanState(v) { subtitleFontFamilyScanState = v; },
    get subtitleFontFamilyScanCount() { return subtitleFontFamilyScanCount; },
    set subtitleFontFamilyScanCount(v) { subtitleFontFamilyScanCount = v; },
    renderSubtitleFontFamilyStatus,
    setSubtitleFontFamilyScanState,
    subtitleFontFamilyOptionExists,
    subtitleFontFamilyDisplayName,
    relabelSubtitleFontFamilyOptions,
    normalizeSubtitleColor,
    normalizeSubtitleAppearance,
    getSubtitleAppearance,
    getStoredExtensionSubtitleAppearance,
    getExtensionSubtitleDefaultFontSize,
    getExtensionSubtitleAppearance,
    syncSubtitleFontSizeSelect,
    syncSubtitleAppearanceControls,
    syncExtensionSubtitleAppearanceControls,
    applySubtitleAppearance,
    applyExtensionSubtitleAppearance,
    setSubtitleAppearance,
    collectSubtitleLocalFontFamilies,
    replaceSubtitleLocalFontOptions,
    initializeSubtitleFontFamilyScanner,
    restoreGrantedSubtitleLocalFonts,
    scanSubtitleLocalFonts,
    setExtensionSubtitleAppearance,
    restoreExtensionSubtitleAppearance
  });
})(typeof window !== 'undefined' ? window : globalThis);
