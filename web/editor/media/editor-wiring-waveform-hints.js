
// === Hint ===
// 右上角提示卡片堆栈：样式在 editor.css（#hint-stack / .hint-card）。
// 最多同时显示 3 条，新提示追加在下方。


  // 与 editor.css 的 hint-fade-out 时长一致





// 振幅到达上下限时由波形模块派发的事件：rAF 节流后仍可能每帧触发，冷却避免提示闪烁


document.addEventListener('asr:waveform-scale-limit', (event) => {
  const { atMin, atMax } = event.detail || {};
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
