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

  global.MaweTheme = Object.freeze({
    applyTheme
  });
})(typeof window !== 'undefined' ? window : globalThis);
