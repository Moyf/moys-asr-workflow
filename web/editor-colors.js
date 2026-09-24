// 调色板：颜色标签、窗口注入的 ASR_EDITOR_PALETTE、内置/自定义五色与应用控件同步。
// 由 split-cluster codemod 自 editor.js 拆出；main #135（ASS 样式库）引入自定义
// 五色后，调色板变为可变状态（let），随设置联动重建并同步给波形运行时。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweColors(global) {
  'use strict';



  // 标记颜色：5 种基础色，用于给字幕分组着色。
  // 数据模型与表情包同构：head 持完整 color {name, value, start, end}，后续 ref 持 color_ref {name, headIdx}
  // 调色板数值唯一来源于 maw/colors.py（渲染时注入 window.ASR_EDITOR_PALETTE）；
  // 这里只补充编辑器 UI 用的中文标签。
  const COLOR_LABELS = { yellow: '黄', green: '绿', red: '红', purple: '紫', blue: '蓝' };

  // 调色板注入守卫（原 editor.js 加载期校验，随调色板初始化一同迁移）。
  if (!Array.isArray(window.ASR_EDITOR_PALETTE) || !window.ASR_EDITOR_PALETTE.length) {
    throw new Error('调色板未注入：缺少 window.ASR_EDITOR_PALETTE（检查 edit.py / serve.py 渲染管线）');
  }
  const COLOR_PALETTE_DEFAULTS = Object.fromEntries(
    window.ASR_EDITOR_PALETTE.map((color) => [color.name, color.value]),
  );

  function currentSubtitleColorPalette() {
    // 开关关闭时不读取自定义值，统一回落到内置五色。
    if (MaweSettings.EDITOR_SETTINGS.subtitleColorPaletteEnabled !== true) {
      return window.AsrEditorUtils.normalizeSubtitleColorPalette(null, COLOR_PALETTE_DEFAULTS);
    }
    return window.AsrEditorUtils.normalizeSubtitleColorPalette(
      MaweSettings.EDITOR_SETTINGS.subtitleColorPalette,
      COLOR_PALETTE_DEFAULTS,
    );
  }

  function buildEditorColorPalette() {
    // 自定义五色关闭时（subtitleColorPaletteEnabled ≠ true）一律使用内置色值。
    const configured = currentSubtitleColorPalette();
    return window.ASR_EDITOR_PALETTE.map((c) => ({
      name: c.name,
      label: COLOR_LABELS[c.name] || c.name,
      value: configured[c.name] || c.value,
    }));
  }
  let COLOR_PALETTE = buildEditorColorPalette();
  let COLOR_BY_NAME = Object.fromEntries(COLOR_PALETTE.map(c => [c.name, c]));
  function rebuildEditorColorPalette() {
    MaweSettings.EDITOR_SETTINGS.subtitleColorPalette = window.AsrEditorUtils.normalizeSubtitleColorPalette(
      MaweSettings.EDITOR_SETTINGS.subtitleColorPalette,
      COLOR_PALETTE_DEFAULTS,
    );
    COLOR_PALETTE = buildEditorColorPalette();
    COLOR_BY_NAME = Object.fromEntries(COLOR_PALETTE.map(c => [c.name, c]));
    window.AsrWaveform?.setColorPalette?.(COLOR_PALETTE);
  }
  window.AsrWaveform?.setColorPalette?.(COLOR_PALETTE);
  function colorValue(name) { return COLOR_BY_NAME[name]?.value || '#777'; }

  // 自定义五色设置控件（main #135）：纯 DOM 引用表与取值/重建/同步逻辑。
  const subtitleColorPaletteEnabledInput = document.getElementById('subtitle-color-palette-enabled');
  const subtitleColorPaletteGrid = document.getElementById('subtitle-color-palette-grid');
  const subtitleColorPaletteNames = window.AsrEditorUtils.EDITOR_SUBTITLE_COLOR_NAMES || [
    'yellow', 'green', 'red', 'purple', 'blue',
  ];
  const subtitleColorPaletteColorInputs = Object.fromEntries(
    subtitleColorPaletteNames.map((name) => [
      name, document.getElementById(`subtitle-color-palette-${name}`),
    ]),
  );
  const subtitleColorPaletteHexInputs = Object.fromEntries(
    subtitleColorPaletteNames.map((name) => [
      name, document.getElementById(`subtitle-color-palette-${name}-hex`),
    ]),
  );
  const subtitleColorPaletteSwatches = Object.fromEntries(
    subtitleColorPaletteNames.map((name) => [
      name, document.querySelector(`[data-subtitle-palette-swatch="${name}"]`),
    ]),
  );
  const subtitleColorPaletteResetButton = document.getElementById('subtitle-color-palette-reset');

  function syncSubtitleColorPaletteControls() {
    const palette = currentSubtitleColorPalette();
    const customEnabled = MaweSettings.EDITOR_SETTINGS.subtitleColorPaletteEnabled === true;
    if (subtitleColorPaletteEnabledInput) subtitleColorPaletteEnabledInput.checked = customEnabled;
    if (subtitleColorPaletteGrid) subtitleColorPaletteGrid.hidden = !customEnabled;
    subtitleColorPaletteNames.forEach((name) => {
      const value = palette[name];
      const colorInput = subtitleColorPaletteColorInputs[name];
      const hexInput = subtitleColorPaletteHexInputs[name];
      const swatch = subtitleColorPaletteSwatches[name];
      if (colorInput && document.activeElement !== colorInput) colorInput.value = value;
      if (hexInput && document.activeElement !== hexInput) hexInput.value = value;
      // 色块是用户感知自定义五色的主要位置，保存/重绘后要和色值控件一起刷新。
      if (swatch) swatch.style.backgroundColor = value;
    });
  }

  function refreshSubtitleColorPalettePresentation() {
    rebuildEditorColorPalette();
    MaweCuePanel.renderAll({ waveform: 'none' });
    MaweCoreState.waveformEditor?.renderSegments?.();
    MawePlaybackLoop.refreshSubtitlePreview();
  }

  function setSubtitleColorPaletteValue(name, value) {
    if (!subtitleColorPaletteNames.includes(name)) return;
    const current = currentSubtitleColorPalette();
    const next = window.AsrEditorUtils.normalizeSubtitleColorPalette(
      { ...current, [name]: value },
      COLOR_PALETTE_DEFAULTS,
    );
    if (next[name] === current[name]) {
      syncSubtitleColorPaletteControls();
      return;
    }
    MaweSettings.updateEditorSettings({ subtitleColorPalette: next });
    syncSubtitleColorPaletteControls();
    refreshSubtitleColorPalettePresentation();
  }

  global.MaweColors = Object.freeze({
    COLOR_LABELS,
    get COLOR_PALETTE() { return COLOR_PALETTE; },
    set COLOR_PALETTE(v) { COLOR_PALETTE = v; },
    get COLOR_BY_NAME() { return COLOR_BY_NAME; },
    set COLOR_BY_NAME(v) { COLOR_BY_NAME = v; },
    COLOR_PALETTE_DEFAULTS,
    get subtitleColorPaletteEnabledInput() { return subtitleColorPaletteEnabledInput; },
    get subtitleColorPaletteGrid() { return subtitleColorPaletteGrid; },
    get subtitleColorPaletteNames() { return subtitleColorPaletteNames; },
    get subtitleColorPaletteColorInputs() { return subtitleColorPaletteColorInputs; },
    get subtitleColorPaletteHexInputs() { return subtitleColorPaletteHexInputs; },
    get subtitleColorPaletteSwatches() { return subtitleColorPaletteSwatches; },
    get subtitleColorPaletteResetButton() { return subtitleColorPaletteResetButton; },
    colorValue,
    buildEditorColorPalette,
    rebuildEditorColorPalette,
    currentSubtitleColorPalette,
    syncSubtitleColorPaletteControls,
    refreshSubtitleColorPalettePresentation,
    setSubtitleColorPaletteValue,
  });
})(typeof window !== 'undefined' ? window : globalThis);
