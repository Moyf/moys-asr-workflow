// 忍者拆分：音效播放、拆分点几何计算与斩击反馈。
// 由 split-cluster codemod 自 editor.js 拆出：状态为本模块私有，外部仅经
// window.MaweNinja 冻结门面访问（可变状态为访问器属性，赋值语义不变）。
// 清单位置在 editor.js 之前；editor.js 全局仅在延迟执行的回调中访问。
(function initMaweNinja(global) {
  'use strict';



  const NINJA_SFX_VARIANTS = Object.freeze([
    'sfx_katana_slash_01.opus',
    'sfx_katana_slash_02.opus',
    'sfx_katana_slash_03.opus',
    'sfx_katana_slash_04.opus',
  ]);


  const NINJA_SFX_PLAYERS = new Map();


  const NINJA_SFX_HISTORY = [];


  let ninjaSlashFlashTimer = 0;



  function ninjaSfxUrl(fileName) {
    const baseUrl = MaweBoot.NINJA_SFX_BASE_URL || MaweBoot.SERVER_CONFIG?.ninjaSfxBaseUrl || 'web/sfx/';
    try {
      return new URL(`${baseUrl}${encodeURIComponent(fileName)}`, document.baseURI).href;
    } catch (_) {
      return `${baseUrl}${encodeURIComponent(fileName)}`;
    }
  }



  function ninjaSfxType(fileName) {
    return fileName.endsWith('.opus') ? 'audio/ogg; codecs=opus' : 'audio/ogg';
  }



  function createNinjaSfxPlayer(fileName) {
    if (typeof Audio !== 'function') return null;
    const player = new Audio();
    player.preload = 'auto';
    player.volume = 0.65;
    const source = document.createElement('source');
    source.src = ninjaSfxUrl(fileName);
    source.type = ninjaSfxType(fileName);
    player.appendChild(source);
    return player;
  }



  function playNinjaSplitSound() {
    if (!MaweSettings.EDITOR_SETTINGS.ninjaMode || typeof Audio !== 'function') return;
    const recent = new Set(NINJA_SFX_HISTORY.slice(-2));
    const available = NINJA_SFX_VARIANTS.map((_, index) => index)
      .filter((index) => !recent.has(index));
    const candidates = available.length ? available : NINJA_SFX_VARIANTS.map((_, index) => index);
    const variantIndex = candidates[Math.floor(Math.random() * candidates.length)];
    NINJA_SFX_HISTORY.push(variantIndex);
    if (NINJA_SFX_HISTORY.length > 2) NINJA_SFX_HISTORY.shift();
    let player = NINJA_SFX_PLAYERS.get(variantIndex);
    if (!player) {
      player = createNinjaSfxPlayer(NINJA_SFX_VARIANTS[variantIndex]);
      if (!player) return;
      NINJA_SFX_PLAYERS.set(variantIndex, player);
    }
    try {
      player.currentTime = 0;
    } catch (_) {
      // 尚未完成解码时 currentTime 可能暂时不可写；播放本身仍可继续尝试。
    }
    const playback = player.play();
    if (playback && typeof playback.catch === 'function') playback.catch(() => {});
  }



  function ninjaSplitPointFromRect(rect) {
    if (!rect) return null;
    const clientX = Number(rect.left) + Number(rect.width || 0) / 2;
    const clientY = Number(rect.top) + Number(rect.height || 0) / 2;
    return Number.isFinite(clientX) && Number.isFinite(clientY) ? { clientX, clientY } : null;
  }



  function ninjaSplitPointFromRange(range, root, offset = 0, textLength = 1) {
    if (range) {
      try {
        const collapsed = range.cloneRange();
        collapsed.collapse(true);
        const rect = collapsed.getBoundingClientRect();
        if (rect && (rect.width || rect.height)) return ninjaSplitPointFromRect(rect);
        const rects = collapsed.getClientRects();
        if (rects.length) return ninjaSplitPointFromRect(rects[0]);
      } catch (_) {
        // 被重绘或脱离 DOM 的 Range 不能再读取几何信息，继续使用元素回退值。
      }
    }
    const rootRect = root?.getBoundingClientRect?.();
    if (!rootRect) return null;
    const safeLength = Math.max(1, Number(textLength) || 1);
    const ratio = Math.max(0, Math.min(1, (Number(offset) || 0) / safeLength));
    return {
      clientX: rootRect.left + rootRect.width * ratio,
      clientY: rootRect.top + rootRect.height / 2,
    };
  }



  function ninjaModalSplitPoint(state, finalCutMs, track = 'main') {
    // 字幕列表/编辑区唤起的拆分弹窗：刀光保留在列表原位置（cue 内拆分位置）。
    if (state?.ninjaFromList && state?.feedbackPoint) return state.feedbackPoint;
    // 波形等其余来源唤起的弹窗：刀光优先落在波形区最终切点上；
    // force 钳制后 finalCutMs 才是实际位置，找不到波形行时回退打开时的反馈点。
    if (Number.isFinite(finalCutMs)) {
      const point = MaweCoreState.waveformEditor?.getSplitPointAtTime?.(finalCutMs, track);
      if (point) return point;
    }
    return state?.feedbackPoint || null;
  }



  function triggerNinjaSplitFeedback(splitPoint = null) {
    if (!MaweSettings.EDITOR_SETTINGS.ninjaMode) return;
    if (MaweSettings.EDITOR_SETTINGS.ninjaSound !== false) playNinjaSplitSound();
    if (!MaweSettings.EDITOR_SETTINGS.ninjaSlashEffect || !MaweDom.ninjaSlashFlash) return;
    // 旋转幅度 0 度 = 完全垂直；N 度 = 在 [-N, N] 内均匀随机，正负决定倾斜方向。
    const rotateAmplitude = Math.max(0, Math.min(60, Math.round(Number(MaweSettings.EDITOR_SETTINGS.ninjaSlashRotateAmplitude) || 0)));
    const slashAngle = rotateAmplitude * (Math.random() * 2 - 1);
    const slashLengthPercent = Math.max(20, Math.min(400, Math.round(Number(MaweSettings.EDITOR_SETTINGS.ninjaSlashLengthPercent) || 80)));
    // 每次触发都随机化刀光时长，避免连续拆分看起来一模一样。
    const slashDur = 160 + Math.random() * 70; // 刀光持续时长 [160, 230] ms
    const slashLinger = 100 + Math.random() * 70; // 刀光淡出余韵 [100, 170] ms
    const viewportWidth = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
    const viewportHeight = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
    const point = ninjaSplitPointFromRect({
      left: Number(splitPoint?.clientX),
      top: Number(splitPoint?.clientY),
    }) || { clientX: viewportWidth / 2, clientY: viewportHeight / 2 };
    const slashStyle = MaweDom.ninjaSlashFlash.style;
    slashStyle.setProperty('--slash-angle', `${slashAngle}deg`);
    slashStyle.setProperty('--slash-height', `${slashLengthPercent}%`);
    slashStyle.setProperty('--slash-dur', `${slashDur}ms`);
    slashStyle.setProperty('--slash-linger', `${slashLinger}ms`);
    slashStyle.setProperty('--slash-x', `${Math.max(0, Math.min(100, point.clientX / viewportWidth * 100))}%`);
    slashStyle.setProperty('--slash-y', `${Math.max(0, Math.min(100, point.clientY / viewportHeight * 100))}%`);
    MaweDom.ninjaSlashFlash.classList.remove('show');
    // 强制重排，让连续快速拆分也能重新播放 CSS 动画。
    void MaweDom.ninjaSlashFlash.offsetWidth;
    MaweDom.ninjaSlashFlash.classList.add('show');
    clearTimeout(ninjaSlashFlashTimer);
    // 清理时间必须覆盖刃光扫过与切痕滞留，否则动画放到一半 .show 就被摘掉。
    ninjaSlashFlashTimer = setTimeout(
      () => MaweDom.ninjaSlashFlash.classList.remove('show'),
      slashDur + slashLinger + 120,
    );
  }



  function applyNinjaSettings() {
    const enabled = MaweSettings.EDITOR_SETTINGS.ninjaMode === true;
    const slashEnabled = enabled && MaweSettings.EDITOR_SETTINGS.ninjaSlashEffect !== false;
    if (MaweDom.ninjaModeToggle) MaweDom.ninjaModeToggle.checked = enabled;
    if (MaweDom.ninjaSoundToggle) MaweDom.ninjaSoundToggle.checked = MaweSettings.EDITOR_SETTINGS.ninjaSound !== false;
    if (MaweDom.ninjaSlashEffectToggle) MaweDom.ninjaSlashEffectToggle.checked = MaweSettings.EDITOR_SETTINGS.ninjaSlashEffect !== false;
    if (MaweDom.ninjaSoundField) MaweDom.ninjaSoundField.hidden = !enabled;
    if (MaweDom.ninjaSlashEffectField) MaweDom.ninjaSlashEffectField.hidden = !enabled;
    if (MaweDom.ninjaSlashParamsField) MaweDom.ninjaSlashParamsField.hidden = !slashEnabled;
    if (MaweDom.ninjaSlashLengthInput) MaweDom.ninjaSlashLengthInput.value = String(MaweSettings.EDITOR_SETTINGS.ninjaSlashLengthPercent);
    if (MaweDom.ninjaSlashRotateInput) MaweDom.ninjaSlashRotateInput.value = String(MaweSettings.EDITOR_SETTINGS.ninjaSlashRotateAmplitude);
    // SVGElement 不一定实现 HTMLElement.hidden；用属性切换才能真正隐藏原剪刀图标。
    if (MaweDom.razorToolSvg) {
      if (enabled) MaweDom.razorToolSvg.setAttribute('hidden', '');
      else MaweDom.razorToolSvg.removeAttribute('hidden');
    }
    if (MaweDom.ninjaRazorIcon) MaweDom.ninjaRazorIcon.hidden = !enabled;
  }

  global.MaweNinja = Object.freeze({
    NINJA_SFX_VARIANTS,
    NINJA_SFX_PLAYERS,
    NINJA_SFX_HISTORY,
    get ninjaSlashFlashTimer() { return ninjaSlashFlashTimer; },
    set ninjaSlashFlashTimer(v) { ninjaSlashFlashTimer = v; },
    ninjaSfxUrl,
    ninjaSfxType,
    createNinjaSfxPlayer,
    playNinjaSplitSound,
    ninjaSplitPointFromRect,
    ninjaSplitPointFromRange,
    ninjaModalSplitPoint,
    triggerNinjaSplitFeedback,
    applyNinjaSettings
  });
})(typeof window !== 'undefined' ? window : globalThis);
