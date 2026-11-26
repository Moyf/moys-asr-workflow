// 调色板：颜色标签、内置和自定义五色，以及应用控件同步。
// 由 split-cluster codemod 自 editor.js 拆出；main #135（ASS 样式库）引入自定义
// 五色后，调色板变为可变状态（let），随设置联动重建并同步给波形运行时。
import { ASR_EDITOR_PALETTE } from '../../shared/editor-palette.js';
import { AsrWaveform } from '../media/waveform.js';
import { MaweBoot } from '../boot/editor-boot.js';
import { MaweColorFilter } from '../cues/editor-color-filter.js';
import { MawePlaybackLoop } from '../media/editor-playback-loop.js';
import { MaweCoreState } from '../state/editor-core-state.js';
import { MaweSettings } from '../state/editor-settings.js';
import { MaweSpeakerLabels } from './editor-speaker-labels.js';
import { syncSpeakerLabelControls } from './editor-speaker-labels.js';
export let MaweColors;
import { AsrEditorUtils } from '../../shared/editor-utils.js';

export function initMaweColors() {
  // 标记颜色：5 种基础色，用于给字幕分组着色。
  // 数据模型与表情包同构：head 持完整 color {name, value, start, end}，后续 ref 持 color_ref {name, headIdx}
  // 内置色值由 maw/colors.py 提供，渲染器嵌入页面。
  // 这里只补充编辑器 UI 用的中文标签。
  const COLOR_LABELS = { yellow: '黄', green: '绿', red: '红', purple: '紫', blue: '蓝', orange: '橙', cyan: '青', magenta: '紫红', gray: '灰' };

  // 调色板注入守卫（原 editor.js 加载期校验，随调色板初始化一同迁移）。
  if (!Array.isArray(ASR_EDITOR_PALETTE) || !ASR_EDITOR_PALETTE.length) {
    throw new Error('调色板未注入：缺少编辑器调色板数据（检查 edit.py / serve.py 渲染管线）');
  }
  const COLOR_PALETTE_DEFAULTS = Object.fromEntries(
    ASR_EDITOR_PALETTE.map((color) => [color.name, color.value]),
  );

  function currentSubtitleColorPalette() {
    // 开关关闭时不读取自定义值，统一回落到内置五色。
    if (MaweSettings.EDITOR_SETTINGS.subtitleColorPaletteEnabled !== true) {
      return AsrEditorUtils.normalizeSubtitleColorPalette(null, COLOR_PALETTE_DEFAULTS);
    }
    return AsrEditorUtils.normalizeSubtitleColorPalette(
      MaweSettings.EDITOR_SETTINGS.subtitleColorPalette,
      COLOR_PALETTE_DEFAULTS,
    );
  }

  function buildEditorColorPalette() {
    // 自定义五色关闭时（subtitleColorPaletteEnabled ≠ true）一律使用内置色值。
    const configured = currentSubtitleColorPalette();
    return ASR_EDITOR_PALETTE.map((c) => ({
      name: c.name,
      label: COLOR_LABELS[c.name] || c.name,
      value: configured[c.name] || c.value,
    }));
  }
  let COLOR_PALETTE = buildEditorColorPalette();
  let COLOR_BY_NAME = Object.fromEntries(COLOR_PALETTE.map(c => [c.name, c]));
  // 五色调色板同步为根级 CSS 变量：cue 列表的 --color-bar 引用这些变量，
  // 调整自定义色值时由变量级联传播，不必重建全部字幕行 DOM（勾选卡顿的根因）。
  function syncSubtitleColorCssVars() {
    const rootStyle = document.documentElement.style;
    for (const color of COLOR_PALETTE) {
      rootStyle.setProperty(`--subtitle-color-${color.name}`, color.value);
    }
  }
  function rebuildEditorColorPalette() {
    MaweSettings.EDITOR_SETTINGS.subtitleColorPalette = AsrEditorUtils.normalizeSubtitleColorPalette(
      MaweSettings.EDITOR_SETTINGS.subtitleColorPalette,
      COLOR_PALETTE_DEFAULTS,
    );
    COLOR_PALETTE = buildEditorColorPalette();
    COLOR_BY_NAME = Object.fromEntries(COLOR_PALETTE.map(c => [c.name, c]));
    syncSubtitleColorCssVars();
    AsrWaveform?.setColorPalette?.(COLOR_PALETTE);
  }
  syncSubtitleColorCssVars();
  AsrWaveform?.setColorPalette?.(COLOR_PALETTE);
  function colorValue(name) { return COLOR_BY_NAME[name]?.value || '#777'; }
  // 供 DOM 内联样式使用：命名色返回变量引用（随调色板联动），未知名字回退实际值。
  function colorCssValue(name) {
    if (COLOR_BY_NAME[name]) return `var(--subtitle-color-${name})`;
    return colorValue(name);
  }

  // 自定义五色设置控件（main #135）：纯 DOM 引用表与取值/重建/同步逻辑。
  const subtitleColorPaletteEnabledInput = /** @type {HTMLInputElement} */ (document.getElementById('subtitle-color-palette-enabled'));
  const subtitleColorPaletteGrid = document.getElementById('subtitle-color-palette-grid');
  const subtitleColorPaletteNames = AsrEditorUtils.EDITOR_SUBTITLE_COLOR_NAMES || [
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
    // 列表 cue 的 --color-bar 已改为引用根级颜色变量，随变量级联自动更新，
    // 不再全量重建字幕行（那是勾选「自定义色值」时明显卡顿的根因）。
    // 仍需手动刷新的是画布波形与实时预览这些吃不到 CSS 变量的表面，
    // 以及把调色板值写进自身样式的过滤菜单色块。
    MaweCoreState.waveformEditor?.renderSegments?.();
    MawePlaybackLoop.refreshSubtitlePreview();
    MaweColorFilter?.renderColorFilterMenu?.();
    if (MaweSpeakerLabels?.syncSpeakerLabelControls) syncSpeakerLabelControls();
  }

  function setSubtitleColorPaletteValue(name, value) {
    if (!subtitleColorPaletteNames.includes(name)) return;
    const current = currentSubtitleColorPalette();
    const next = AsrEditorUtils.normalizeSubtitleColorPalette(
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

  MaweColors = Object.freeze({
    COLOR_LABELS,
    get COLOR_PALETTE() { return COLOR_PALETTE; },
    set COLOR_PALETTE(v) { COLOR_PALETTE = v; },
    get ACTIVE_COLOR_PALETTE() { return COLOR_PALETTE.slice(0, MaweBoot?.DATA?.palette_size === 9 ? 9 : 5); },
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
    colorCssValue,
    buildEditorColorPalette,
    rebuildEditorColorPalette,
    currentSubtitleColorPalette,
    syncSubtitleColorPaletteControls,
    refreshSubtitleColorPalettePresentation,
    setSubtitleColorPaletteValue,
  });
}

export function syncSubtitleColorPaletteControls(...args) { return MaweColors.syncSubtitleColorPaletteControls(...args); }
export function rebuildEditorColorPalette(...args) { return MaweColors.rebuildEditorColorPalette(...args); }
