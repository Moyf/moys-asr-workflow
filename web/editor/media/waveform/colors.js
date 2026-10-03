// colors: waveform helpers with explicit dependencies.
window.MAWE.register('waveform-colors', function createWaveformModule(dependencies) {
  'use strict';

  // 调色板数值唯一来源于 maw/speaker.py，渲染时注入 window.ASR_EDITOR_PALETTE；
  // Node 测试等无注入环境回退为空表（colorForSegment 走存储值兜底）。
  let PALETTE = Object.fromEntries(
    ((typeof window !== 'undefined' && window.ASR_EDITOR_PALETTE) || []).map((c) => [c.name, c.value]),
  );


  function setColorPalette(value) {
    const entries = Array.isArray(value) ? value : [];
    PALETTE = Object.fromEntries(entries
      .filter((entry) => entry && typeof entry.name === 'string' && typeof entry.value === 'string')
      .map((entry) => [entry.name, entry.value]));
  }


  function colorForSegment(segment) {
    if (segment.color?.name && PALETTE[segment.color.name]) return PALETTE[segment.color.name];
    if (segment.color_ref?.name && PALETTE[segment.color_ref.name]) return PALETTE[segment.color_ref.name];
    if (segment.color?.value) return segment.color.value;
    return '#66727d';
  }


  function hasSubtitleColor(segment) {
    return Boolean(
      (segment.color?.name && PALETTE[segment.color.name])
      || (segment.color_ref?.name && PALETTE[segment.color_ref.name])
      || segment.color?.value,
    );
  }

  return Object.freeze({ colorForSegment, hasSubtitleColor, setColorPalette });
});
