
import { MaweHint } from "../ui/editor-hint.js";

// 真 ESM：wiring 顶层接线（原转换体 phase-1/phase-2 = import 求值）。
'use strict';
document.addEventListener('asr:waveform-scale-limit', (event) => {
  const { atMin, atMax } = /** @type {CustomEvent<{ atMin?: boolean, atMax?: boolean }>} */ (event).detail || {};
  const msg = atMin ? '已经到达最小振幅' : atMax ? '已经达到最大振幅' : '';
  if (!msg) return;
  const now = Date.now();
  if (msg === MaweHint.lastScaleLimitMsg && now - MaweHint.lastScaleLimitAt < 1200) return;
  MaweHint.lastScaleLimitMsg = msg;
  MaweHint.lastScaleLimitAt = now;
  MaweHint.flashHint(msg);
});

document.addEventListener('asr:waveform-loudness-unavailable', () => {
  MaweHint.flashHint('当前媒体没有响度缓存，无法按响度适配', 'warning');
});
