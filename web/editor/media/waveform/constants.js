// constants: waveform helpers with explicit dependencies.
window.MAWE.register('waveform-constants', function createWaveformModule(dependencies) {
  'use strict';


  const SETTINGS_KEY = 'moy.asr.waveform.settings.v1';

  const SCHEMA = 'moy.asr.waveform.v1';

  const ENCODING = 'i8-minmax-base64';

  const SPECTRAL_SCHEMA = 'moy.asr.spectral.v1';

  const SPECTRAL_ENCODING = 'u16-freq-density-base64';

  const LOUDNESS_SCHEMA = 'moy.asr.loudness.v1';

  const WORKSPACE_SCHEMA = 'moy.asr.editor.workspace.v1';

  const POINTER_DRAG_THRESHOLD_PX = 3;

  const ZOOM_PRESETS = [2, 5, 10, 20, 30, 60];

  const ROW_PRESETS = [2, 5, 10, 20, 30];

  const ROW_HEIGHT_PRESETS = [64, 80, 96, 120, 144, 168, 192];

  const ROW_GAP = 10;

  const SPLIT_FLASH_DURATION_MS = 720;

  // 多行波形保留视口前后少量行，字幕快捷键跨行时可以直接复用已绘制的行。
  // 行本身仍按可视区增量创建，不会把整段长媒体一次性放进 DOM。
  const MULTI_ROW_BUFFER = 2;

  const MIN_CUE_MS = 100;

  const MIN_WAVEFORM_SCALE = 0.25;

  const MAX_WAVEFORM_SCALE = 6;

  const SNAP_MS = 80;

  const ROUND_MS = 10;

  // 连续 seek 会让浏览器反复解码并触发编辑器刷新；拖动时保留约 30 FPS
  // 的定位更新，松开指针时再补一次精确 seek。
  const PLAYHEAD_DRAG_SEEK_INTERVAL_MS = 32;

  const WAVEFORM_ADJUST_DEBOUNCE_MS = 160;

  const BROWSER_DECODE_LIMIT = 512 * 1024 * 1024;

  const BROWSER_PCM_ESTIMATE_LIMIT = 768 * 1024 * 1024;

  // 右侧整列波形布局：当前字幕编辑区略收紧，把空间让给字幕列表。
  const DEFAULT_LAYOUT_ROWS = [42, 16, 42];


  function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
  }

  return Object.freeze({ BROWSER_DECODE_LIMIT, BROWSER_PCM_ESTIMATE_LIMIT, DEFAULT_LAYOUT_ROWS, ENCODING, LOUDNESS_SCHEMA, MAX_WAVEFORM_SCALE, MIN_CUE_MS, MIN_WAVEFORM_SCALE, MULTI_ROW_BUFFER, PLAYHEAD_DRAG_SEEK_INTERVAL_MS, POINTER_DRAG_THRESHOLD_PX, ROUND_MS, ROW_GAP, ROW_HEIGHT_PRESETS, ROW_PRESETS, SCHEMA, SETTINGS_KEY, SNAP_MS, SPECTRAL_ENCODING, SPECTRAL_SCHEMA, SPLIT_FLASH_DURATION_MS, WAVEFORM_ADJUST_DEBOUNCE_MS, WORKSPACE_SCHEMA, ZOOM_PRESETS, clamp });
});
