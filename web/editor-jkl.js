// J/K/L 播放控制：双模式（速度/倒放）状态机与速率档位。editor.js 在加载期经本模块门面初始化 UI。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweJklPlayback 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweJklPlayback(global) {
  'use strict';


  let jklPlaybackRate = 1;


  let jklReversePlaying = false;


  let jklReverseFrameId = 0;


  let jklReverseLastTimestamp = 0;


  const jklPlaybackModeSelect = document.getElementById('jkl-playback-mode');


  const jklPlaybackModeHint = document.getElementById('jkl-playback-mode-hint');


  const helpJklMode = document.getElementById('help-jkl-mode');



  const JKL_MODE_UI_TEXT = {
    zh: {
      speed: { help: '倍速 ×0.5/重置/×2', hint: 'J 慢放，K 重置 1×，L 加速。' },
      direction: { help: '倒放/停止/1×播放', hint: 'J 倒放，K 停止（重置播放速度），K 播放。多次按 J/K 可以倍增速度。' },
    },
    en: {
      speed: { help: 'Speed ×0.5/reset/×2', hint: 'J slows down, K resets to 1×, and L speeds up.' },
      direction: { help: 'Reverse/stop/1× play', hint: 'J reverses; K stops (resetting playback speed), and K plays. Press J/K repeatedly to multiply the speed.' },
    },
  };


  function refreshJklPlaybackModeUi() {
    const language = window.MAWE_I18N?.language === 'en' ? 'en' : 'zh';
    const mode = MaweSettings.normalizeJklPlaybackMode(MaweSettings.EDITOR_SETTINGS.jklPlaybackMode);
    const text = JKL_MODE_UI_TEXT[language][mode];
    if (jklPlaybackModeSelect) jklPlaybackModeSelect.value = mode;
    if (jklPlaybackModeHint) jklPlaybackModeHint.textContent = text.hint;
    if (helpJklMode) helpJklMode.textContent = text.help;
  }



  function isJklDirectionMode() {
    return MaweSettings.EDITOR_SETTINGS.jklPlaybackMode === 'direction';
  }



  function stopJklReversePlayback({ render = true } = {}) {
    if (jklReverseFrameId) cancelAnimationFrame(jklReverseFrameId);
    jklReverseFrameId = 0;
    jklReverseLastTimestamp = 0;
    const wasPlaying = jklReversePlaying;
    jklReversePlaying = false;
    if (render && wasPlaying) {
      update();
      MaweCoreState.waveformEditor?.updatePlayback();
    }
    if (render) syncMediaControls();
  }



  function stepJklReversePlayback(timestamp) {
    jklReverseFrameId = 0;
    if (!jklReversePlaying || !MaweCoreState.player) return;
    if (!jklReverseLastTimestamp) jklReverseLastTimestamp = timestamp;
    const elapsed = Math.min(
      0.1,
      Math.max(0, (timestamp - jklReverseLastTimestamp) / 1000),
    );
    jklReverseLastTimestamp = timestamp;
    const current = Number(MaweCoreState.player.currentTime);
    const rate = Math.max(0.0625, Math.abs(jklPlaybackRate));
    const next = Number.isFinite(current) ? current - elapsed * rate : 0;
    if (!Number.isFinite(current) || next <= 0) {
      MaweCoreState.player.currentTime = 0;
      jklReversePlaying = false;
      jklReverseLastTimestamp = 0;
      update();
      MaweCoreState.waveformEditor?.updatePlayback();
      syncMediaControls();
      return;
    }
    MaweCoreState.player.currentTime = next;
    updatePlaybackFrame();
    renderStickerOverlay(next * 1000);
    syncMediaControls();
    if (jklReversePlaying) jklReverseFrameId = requestAnimationFrame(stepJklReversePlayback);
  }



  function startJklReversePlayback() {
    if (!hasLoadedMedia()) {
      MaweHint.flashHint('请先加载媒体，然后才能预览', 'invalid');
      return false;
    }
    jklReversePlaying = true;
    jklReverseLastTimestamp = 0;
    MaweCoreState.player.playbackRate = Math.max(0.0625, Math.abs(jklPlaybackRate));
    if (!MaweCoreState.player.paused) MaweCoreState.player.pause();
    if (!jklReverseFrameId) jklReverseFrameId = requestAnimationFrame(stepJklReversePlayback);
    syncMediaControls();
    return true;
  }



  function playJklForward() {
    if (!hasLoadedMedia()) {
      MaweHint.flashHint('请先加载媒体，然后才能预览', 'invalid');
      return false;
    }
    stopJklReversePlayback({ render: false });
    MaweCoreState.player.playbackRate = Math.max(0.0625, Math.abs(jklPlaybackRate));
    const promise = MaweCoreState.player.play();
    if (promise && promise.catch) promise.catch(() => {});
    syncMediaControls();
    return true;
  }


  const JKL_PLAYBACK_RATE_STEPS = [1, 2, 4, 8, 16];


  function nextJklDirectionRate(current, direction) {
    const rate = Number.isFinite(current) && current !== 0 ? current : 1;
    const magnitude = Math.abs(rate);
    let stepIndex = 0;
    let smallestDistance = Infinity;
    JKL_PLAYBACK_RATE_STEPS.forEach((step, index) => {
      const distance = Math.abs(step - magnitude);
      if (distance < smallestDistance) {
        smallestDistance = distance;
        stepIndex = index;
      }
    });
    if (direction < 0) {
      if (rate < 0) return -JKL_PLAYBACK_RATE_STEPS[Math.min(stepIndex + 1, JKL_PLAYBACK_RATE_STEPS.length - 1)];
      if (stepIndex === 0) return -1;
      return JKL_PLAYBACK_RATE_STEPS[stepIndex - 1];
    }
    if (rate < 0) {
      if (stepIndex === 0) return 1;
      return -JKL_PLAYBACK_RATE_STEPS[stepIndex - 1];
    }
    return JKL_PLAYBACK_RATE_STEPS[Math.min(stepIndex + 1, JKL_PLAYBACK_RATE_STEPS.length - 1)];
  }

  global.MaweJklPlayback = Object.freeze({
    get jklPlaybackRate() { return jklPlaybackRate; },
    set jklPlaybackRate(v) { jklPlaybackRate = v; },
    get jklReversePlaying() { return jklReversePlaying; },
    set jklReversePlaying(v) { jklReversePlaying = v; },
    get jklReverseFrameId() { return jklReverseFrameId; },
    set jklReverseFrameId(v) { jklReverseFrameId = v; },
    get jklReverseLastTimestamp() { return jklReverseLastTimestamp; },
    set jklReverseLastTimestamp(v) { jklReverseLastTimestamp = v; },
    jklPlaybackModeSelect,
    jklPlaybackModeHint,
    helpJklMode,
    JKL_MODE_UI_TEXT,
    refreshJklPlaybackModeUi,
    isJklDirectionMode,
    stopJklReversePlayback,
    stepJklReversePlayback,
    startJklReversePlayback,
    playJklForward,
    JKL_PLAYBACK_RATE_STEPS,
    nextJklDirectionRate
  });
})(typeof window !== 'undefined' ? window : globalThis);
