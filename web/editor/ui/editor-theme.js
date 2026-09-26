// 主题：明暗色应用。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweTheme 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweTheme(global) {
  'use strict';


  function applyTheme(theme, { rerenderWaveform = true } = {}) {
    const preference = normalizeEditorTheme(theme);
    const resolved = resolveEditorTheme(preference);
    if (resolved === 'light') document.documentElement.dataset.theme = 'light';
    else delete document.documentElement.dataset.theme;
    refreshEditorThemeOptions(preference);
    // 画布颜色是 JS 读取的令牌快照，必须全量重绘才能跟随主题
    if (rerenderWaveform && MaweCoreState.waveformEditor) MaweCoreState.waveformEditor.render();
  }



  // 明暗主题与界面强调色：令牌全部定义在 CSS，
  // 这里只负责解析偏好、写 <html> 数据属性、持久化，以及通知波形重绘画布。
  const EDITOR_THEME_VALUES = Object.freeze(['light', 'dark', 'system']);


  const EDITOR_ACCENT_COLOR_DEBOUNCE_MS = 160;


  function normalizeEditorTheme(theme) {
    return EDITOR_THEME_VALUES.includes(theme) ? theme : 'dark';
  }


  function resolveEditorTheme(theme) {
    const preference = normalizeEditorTheme(theme);
    if (preference !== 'system') return preference;
    const media = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    return media ? (media.matches ? 'dark' : 'light') : 'dark';
  }


  function refreshEditorThemeOptions(theme) {
    const preference = normalizeEditorTheme(theme);
    MaweDom.editorThemeOptions.forEach((option) => {
      const active = option.dataset.editorTheme === preference;
      option.classList.toggle('active', active);
      option.setAttribute('aria-pressed', String(active));
    });
  }


  function refreshEditorAccentOptions(accentColor) {
    const preference = MaweSettings.normalizeEditorAccentColor(accentColor);
    MaweDom.editorAccentOptions.forEach((option) => {
      const active = option.dataset.editorAccent === preference;
      option.classList.toggle('active', active);
      option.setAttribute('aria-pressed', String(active));
    });
  }


  function applyEditorAccentColor(accentColor, { rerenderWaveform = true } = {}) {
    const preference = MaweSettings.normalizeEditorAccentColor(accentColor);
    const customColor = MaweSettings.normalizeEditorAccentCustomColor(MaweSettings.EDITOR_SETTINGS.accentColorCustom);
    const root = document.documentElement;
    root.dataset.accent = preference;
    if (preference === 'custom') root.style.setProperty('--accent-custom', customColor);
    else root.style.removeProperty('--accent-custom');
    refreshEditorAccentOptions(preference);
    if (MaweDom.editorAccentCustomField) MaweDom.editorAccentCustomField.hidden = preference !== 'custom';
    if (MaweDom.editorAccentCustomInput) MaweDom.editorAccentCustomInput.value = customColor;
    if (MaweDom.editorAccentCustomValue) MaweDom.editorAccentCustomValue.textContent = customColor;
    // 波形画布颜色是 JS 读取的令牌快照，强调色切换后同样需要重绘。
    if (rerenderWaveform && MaweCoreState.waveformEditor) MaweCoreState.waveformEditor.render();
  }


  let editorAccentCustomColorTimer = 0;


  let pendingEditorAccentCustomColor = null;


  function flushEditorAccentCustomColor(value = MaweDom.editorAccentCustomInput?.value) {
    if (editorAccentCustomColorTimer) {
      window.clearTimeout(editorAccentCustomColorTimer);
      editorAccentCustomColorTimer = 0;
    }
    const customColor = MaweSettings.normalizeEditorAccentCustomColor(value);
    pendingEditorAccentCustomColor = null;
    MaweSettings.updateEditorSettings({ accentColor: 'custom', accentColorCustom: customColor });
    applyEditorAccentColor('custom');
  }


  function scheduleEditorAccentCustomColor(value) {
    pendingEditorAccentCustomColor = MaweSettings.normalizeEditorAccentCustomColor(value);
    if (editorAccentCustomColorTimer) window.clearTimeout(editorAccentCustomColorTimer);
    editorAccentCustomColorTimer = window.setTimeout(() => {
      editorAccentCustomColorTimer = 0;
      const customColor = pendingEditorAccentCustomColor;
      pendingEditorAccentCustomColor = null;
      if (customColor) flushEditorAccentCustomColor(customColor);
    }, EDITOR_ACCENT_COLOR_DEBOUNCE_MS);
  }


  const editorSystemThemeMedia = typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)') : null;


  const refreshEditorSystemTheme = () => {
    if (MaweSettings.EDITOR_SETTINGS.theme === 'system') MaweTheme.applyTheme('system');
  };

  global.MaweTheme = Object.freeze({
    EDITOR_THEME_VALUES,
    EDITOR_ACCENT_COLOR_DEBOUNCE_MS,
    normalizeEditorTheme,
    resolveEditorTheme,
    refreshEditorThemeOptions,
    refreshEditorAccentOptions,
    applyEditorAccentColor,
    get editorAccentCustomColorTimer() { return editorAccentCustomColorTimer; },
    set editorAccentCustomColorTimer(v) { editorAccentCustomColorTimer = v; },
    get pendingEditorAccentCustomColor() { return pendingEditorAccentCustomColor; },
    set pendingEditorAccentCustomColor(v) { pendingEditorAccentCustomColor = v; },
    flushEditorAccentCustomColor,
    scheduleEditorAccentCustomColor,
    editorSystemThemeMedia,
    refreshEditorSystemTheme,
    applyTheme
  });
})(typeof window !== 'undefined' ? window : globalThis);
