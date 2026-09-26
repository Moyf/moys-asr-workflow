// ass-animation: private helpers; dependencies are injected by editor-utils.js.
window.MAWE.register('utils-ass-animation', function createUtilsModule(dependencies) {
  'use strict';
  const { ASS_DEFAULT_PLAY_RES_X, ASS_DEFAULT_PLAY_RES_Y, normalizeAssAnimations } = dependencies;


  function assAnimationOverrideTags(profile, { includeMove = true } = {}) {
    const animations = normalizeAssAnimations(profile?.animations);
    const tags = [];
    // libass/playback behaviour is undefined when both fade forms are present.
    // The more expressive form wins, while the simple fad remains the normal
    // one-click path in the style manager.
    if (animations.fade.enabled) {
      const { alpha1, alpha2, alpha3, t1, t2, t3, t4 } = animations.fade;
      tags.push(`\\fade(${alpha1},${alpha2},${alpha3},${t1},${t2},${t3},${t4})`);
    } else if (animations.fad.enabled) {
      tags.push(`\\fad(${animations.fad.inMs},${animations.fad.outMs})`);
    }
    // \move 的坐标是主字幕画布上的绝对 PlayRes 坐标；叠加轨的锚定由
    // MarginV 堆叠负责，不跟随 move（includeMove: false 时省略）。
    if (includeMove && animations.move.enabled) {
      const { x1, y1, x2, y2, t1, t2 } = animations.move;
      tags.push(`\\move(${x1},${y1},${x2},${y2},${t1},${t2})`);
    }
    if (animations.t.enabled && animations.t.tags) {
      const { startMs, endMs, accel, tags: transformTags } = animations.t;
      tags.push(`\\t(${startMs},${endMs},${accel},${transformTags})`);
    }
    return tags.join('');
  }


  function assPreviewAnimationState(profile, elapsedMs, durationMs, {
    playResX = ASS_DEFAULT_PLAY_RES_X,
    playResY = ASS_DEFAULT_PLAY_RES_Y,
    stageWidth = 0,
    stageHeight = 0,
  } = {}) {
    const animations = normalizeAssAnimations(profile?.animations);
    const elapsed = Math.max(0, Number(elapsedMs) || 0);
    const duration = Math.max(1, Number(durationMs) || 1);
    let opacity = 1;
    const interpolate = (start, end, from, to) => {
      if (to <= from) return elapsed >= to ? end : start;
      const amount = Math.min(1, Math.max(0, (elapsed - from) / (to - from)));
      return start + (end - start) * amount;
    };
    if (animations.fade.enabled) {
      const fade = animations.fade;
      let alpha = fade.alpha1;
      if (elapsed < fade.t1) alpha = fade.alpha1;
      else if (elapsed < fade.t2) alpha = interpolate(fade.alpha1, fade.alpha2, fade.t1, fade.t2);
      else if (elapsed < fade.t3) alpha = fade.alpha2;
      else if (elapsed < fade.t4) alpha = interpolate(fade.alpha2, fade.alpha3, fade.t3, fade.t4);
      else alpha = fade.alpha3;
      opacity = 1 - Math.min(255, Math.max(0, alpha)) / 255;
    } else if (animations.fad.enabled) {
      const fadeIn = animations.fad.inMs > 0 && elapsed < animations.fad.inMs
        ? elapsed / animations.fad.inMs : 1;
      const fadeOutStart = Math.max(0, duration - animations.fad.outMs);
      const fadeOut = animations.fad.outMs > 0 && elapsed > fadeOutStart
        ? Math.max(0, (duration - elapsed) / animations.fad.outMs) : 1;
      opacity = Math.min(1, fadeIn, fadeOut);
    }
    let moveX = 0;
    let moveY = 0;
    if (animations.move.enabled) {
      const move = animations.move;
      const amount = move.t2 <= move.t1
        ? (elapsed >= move.t2 ? 1 : 0)
        : Math.min(1, Math.max(0, (elapsed - move.t1) / (move.t2 - move.t1)));
      moveX = move.x1 + (move.x2 - move.x1) * amount;
      moveY = move.y1 + (move.y2 - move.y1) * amount;
    }
    let transformProgress = null;
    if (animations.t.enabled && animations.t.tags) {
      const start = animations.t.startMs;
      const end = animations.t.endMs;
      const linear = end <= start
        ? (elapsed >= end ? 1 : 0)
        : Math.min(1, Math.max(0, (elapsed - start) / (end - start)));
      transformProgress = Math.pow(linear, Math.max(0.01, animations.t.accel));
    }
    const safePlayResX = Math.max(1, Number(playResX) || ASS_DEFAULT_PLAY_RES_X);
    const safePlayResY = Math.max(1, Number(playResY) || ASS_DEFAULT_PLAY_RES_Y);
    return {
      opacity,
      moveX,
      moveY,
      moveOffsetX: animations.move.enabled
        ? (moveX - animations.move.x1) * (Number(stageWidth) || 0) / safePlayResX : 0,
      moveOffsetY: animations.move.enabled
        ? (moveY - animations.move.y1) * (Number(stageHeight) || 0) / safePlayResY : 0,
      transformProgress,
    };
  }

  return Object.freeze({ assAnimationOverrideTags, assPreviewAnimationState });
});
