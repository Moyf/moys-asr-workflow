// colors: waveform helpers with explicit dependencies.
export function createWaveformModule(dependencies) {
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


  function groupColor(segment) {
    if (dependencies.getSegmentDisplayColor) return dependencies.getSegmentDisplayColor(segment);
    return dependencies.getSubtitleGroupValue?.(segment, 'color') || segment.color
      || (segment.color_ref?.name ? { name: segment.color_ref.name } : null);
  }
  function colorForSegment(segment) {
    const color = groupColor(segment);
    return dependencies.getSegmentDisplayColor ? color?.value || '#66727d'
      : PALETTE[color?.name] || color?.value || '#66727d';
  }
  function hasSubtitleColor(segment) {
    const color = groupColor(segment);
    return Boolean(PALETTE[color?.name] || color?.value);
  }

  return Object.freeze({ colorForSegment, hasSubtitleColor, setColorPalette });
}
